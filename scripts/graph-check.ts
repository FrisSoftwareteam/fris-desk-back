// Checks the Microsoft Graph configuration in backend/.env without reading any mail content:
// gets an app-only token and reads the shared mailbox's Inbox name and item counts.
// Run with: npm run graph:check

import { GraphError } from '@microsoft/microsoft-graph-client';
import { getGraph } from '../src/services/graph/GraphService.ts';

const graph = getGraph();
if (!graph) {
  console.error(
    'Graph is not configured. Set AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET and GRAPH_SHARED_MAILBOX.',
  );
  process.exit(1);
}

try {
  const inbox = await graph.getInbox();
  console.log(`OK — connected to ${graph.mailbox}`);
  console.log(`Inbox "${inbox.displayName}": ${inbox.totalItemCount} items, ${inbox.unreadItemCount} unread`);
} catch (err) {
  const status = err instanceof GraphError ? err.statusCode : undefined;
  const code = err instanceof GraphError ? err.code : undefined;
  console.error(`FAILED${status ? ` (HTTP ${status}${code ? `, ${code}` : ''})` : ''}: ${(err as Error).message}`);
  if (status === 401)
    console.error('→ Check AZURE_CLIENT_SECRET (use the secret VALUE, not its ID) and that it has not expired.');
  if (status === 403 || code === 'ErrorAccessDenied') {
    console.error('→ Grant the Mail.ReadWrite and Mail.Send APPLICATION permissions with admin consent, and check the');
    console.error('  Application Access Policy includes this mailbox (README, Microsoft 365 setup steps 4–5).');
  }
  if (status === 404 || code === 'ErrorInvalidUser' || code === 'MailboxNotEnabledForRESTAPI') {
    console.error('→ Check GRAPH_SHARED_MAILBOX is the exact address of an Exchange Online mailbox.');
  }
  process.exit(1);
}
