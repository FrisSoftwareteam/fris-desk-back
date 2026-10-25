#!/usr/bin/env bash
# Creates (or updates) the Azure App Service that runs the Registrar Desk API, and loads its
# settings. Safe to re-run: existing resources are kept and settings are updated.
#
# Needs the Azure CLI, signed in (`az login`) to the right subscription (`az account set -s …`).
#
#   cp .env.production.example .env.production.local   # fill it in; it's git-ignored
#   APP=registrar-desk-api bash scripts/azure-provision.sh
#
# Optional: RG (resource group), LOCATION, PLAN, SKU, SETTINGS_FILE.
set -euo pipefail

APP="${APP:?Set APP to the web app name (globally unique; becomes <APP>.azurewebsites.net)}"
RG="${RG:-registrar-desk-rg}"
LOCATION="${LOCATION:-southafricanorth}"
PLAN="${PLAN:-registrar-desk-plan}"
# B1 or higher: Always On (needed for the mail sync and scheduled jobs) isn't available on Free/Shared.
SKU="${SKU:-B1}"
SETTINGS_FILE="${SETTINGS_FILE:-.env.production.local}"

cd "$(dirname "$0")/.."

# ── Read and check the settings file ────────────────────────────────────────
[[ -f "$SETTINGS_FILE" ]] || { echo "Missing $SETTINGS_FILE (copy .env.production.example and fill it in)" >&2; exit 1; }
settings=()
seen=" "   # keys set, space-separated (macOS ships bash 3.2: no associative arrays)
while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%$'\r'}"
  [[ -z "${line// }" || "$line" =~ ^[[:space:]]*# ]] && continue
  key="${line%%=*}"
  value="${line#*=}"
  [[ -z "$value" ]] && continue          # empty = use the app's default
  settings+=("$key=$value")
  seen="$seen$key "
done < "$SETTINGS_FILE"

for key in MONGODB_URI JWT_SECRET FRONTEND_ORIGIN APP_BASE_URL; do
  [[ "$seen" == *" $key "* ]] || { echo "$SETTINGS_FILE must set $key" >&2; exit 1; }
done
if grep -Eq '^[[:space:]]*AUTH_DEV_LOGIN[[:space:]]*=[[:space:]]*true' "$SETTINGS_FILE"; then
  echo "AUTH_DEV_LOGIN=true is not allowed in production (the API refuses to start)" >&2
  exit 1
fi

az account show --query '{subscription:name}' -o tsv >/dev/null

# ── Resources ───────────────────────────────────────────────────────────────
echo "Resource group $RG ($LOCATION)"
az group create -n "$RG" -l "$LOCATION" -o none

if ! az appservice plan show -g "$RG" -n "$PLAN" -o none 2>/dev/null; then
  echo "App Service plan $PLAN ($SKU, Linux)"
  # One instance only: live presence, rate limits and scheduled jobs are kept in memory.
  az appservice plan create -g "$RG" -n "$PLAN" --is-linux --sku "$SKU" --number-of-workers 1 -o none
fi

if ! az webapp show -g "$RG" -n "$APP" -o none 2>/dev/null; then
  echo "Web app $APP (Node 22)"
  az webapp create -g "$RG" -p "$PLAN" -n "$APP" --runtime "NODE:22-lts" -o none
fi

echo "Configuring the web app"
az webapp update -g "$RG" -n "$APP" --https-only true --client-affinity-enabled false -o none
az webapp config set -g "$RG" -n "$APP" \
  --startup-file "node dist/index.js" \
  --always-on true \
  --web-sockets-enabled true \
  --http20-enabled true \
  --min-tls-version 1.2 \
  --ftps-state Disabled \
  --generic-configurations '{"healthCheckPath": "/api/health"}' \
  -o none

# The GitHub workflow deploys with a publish profile, which needs basic auth on the deployment (SCM) site.
az resource update -g "$RG" --namespace Microsoft.Web --resource-type basicPublishingCredentialsPolicies \
  --parent "sites/$APP" --name scm --set properties.allow=true -o none

echo "Loading ${#settings[@]} settings from $SETTINGS_FILE"
az webapp config appsettings set -g "$RG" -n "$APP" -o none --settings \
  NODE_ENV=production \
  TZ=Africa/Lagos \
  SCM_DO_BUILD_DURING_DEPLOYMENT=false \
  "${settings[@]}"

# ── What to do next ─────────────────────────────────────────────────────────
host=$(az webapp show -g "$RG" -n "$APP" --query defaultHostName -o tsv)
ips=$(az webapp show -g "$RG" -n "$APP" --query possibleOutboundIpAddresses -o tsv)
cat <<NEXT

Done: https://$host

Next steps (see DEPLOYMENT.md):
  1. MongoDB Atlas → Network Access: allow these outbound addresses of the web app:
     $ips
  2. GitHub repository → Settings → Secrets and variables → Actions:
       secret   AZURE_WEBAPP_PUBLISH_PROFILE  (az webapp deployment list-publishing-profiles -g $RG -n $APP --xml)
       variable AZURE_WEBAPP_NAME = $APP
  3. Push to main (or run the workflow) to deploy, then check https://$host/api/health
NEXT
