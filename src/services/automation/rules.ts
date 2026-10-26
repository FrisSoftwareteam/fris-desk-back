// Pure routing-rule logic (BUILD_SPEC §5 `assignmentRules`), kept free of the database so it can be
// unit-tested. The database side (round-robin cursor, applying to a ticket) is in routing.ts.

import type { AssignmentMode } from '../../shared.js';

export type ConditionField = 'subject' | 'fromEmail' | 'fromDomain' | 'body';
export type ConditionOp = 'contains' | 'equals';

export interface RuleCondition {
  field: ConditionField;
  op: ConditionOp;
  value: string;
}

export interface RuleAction {
  setFolderId?: string | null;
  addCategoryIds?: string[];
  assignStrategy?: 'round_robin' | 'specific' | null;
  assigneeId?: string | null;
  /** Mail redirection: forward the incoming email to this address. */
  redirectTo?: string | null;
}

export interface RuleLike {
  id: string;
  name: string;
  priority: number;
  isActive: boolean;
  conditions: RuleCondition[];
  action: RuleAction;
}

export interface IncomingMail {
  subject: string;
  fromEmail: string;
  bodyText: string;
}

function fieldValue(mail: IncomingMail, field: ConditionField): string {
  switch (field) {
    case 'subject':
      return mail.subject;
    case 'fromEmail':
      return mail.fromEmail;
    case 'fromDomain':
      return mail.fromEmail.split('@')[1] ?? '';
    case 'body':
      return mail.bodyText;
  }
}

/** A rule matches when ALL its conditions hold (case-insensitive). A rule with no conditions never matches. */
export function ruleMatches(rule: Pick<RuleLike, 'conditions'>, mail: IncomingMail): boolean {
  if (rule.conditions.length === 0) return false;
  return rule.conditions.every((c) => {
    const actual = fieldValue(mail, c.field).trim().toLowerCase();
    const expected = c.value.trim().toLowerCase();
    if (!expected) return false;
    return c.op === 'equals' ? actual === expected : actual.includes(expected);
  });
}

export interface RoutingDecision {
  folderId: string | null | undefined;
  categoryIds: string[];
  /** The rule that decides assignment, if any. */
  assignmentRule: RuleLike | null;
  redirects: { rule: RuleLike; to: string }[];
  matchedRuleIds: string[];
}

/**
 * Applies every matching active rule in priority order (lower number first). For single-valued
 * outcomes — folder and assignment — the highest-priority matching rule wins; categories from all
 * matching rules are combined; every matching redirect is carried out.
 */
export function decideRouting(rules: RuleLike[], mail: IncomingMail): RoutingDecision {
  const decision: RoutingDecision = {
    folderId: undefined,
    categoryIds: [],
    assignmentRule: null,
    redirects: [],
    matchedRuleIds: [],
  };
  const ordered = rules
    .filter((r) => r.isActive)
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
  for (const rule of ordered) {
    if (!ruleMatches(rule, mail)) continue;
    decision.matchedRuleIds.push(rule.id);
    const a = rule.action;
    if (decision.folderId === undefined && a.setFolderId) decision.folderId = a.setFolderId;
    for (const c of a.addCategoryIds ?? []) if (!decision.categoryIds.includes(c)) decision.categoryIds.push(c);
    if (!decision.assignmentRule && a.assignStrategy) decision.assignmentRule = rule;
    if (a.redirectTo) decision.redirects.push({ rule, to: a.redirectTo });
  }
  return decision;
}

/**
 * Officers reserved by an active "assign to one officer" rule (id → rule name). Officer pools skip
 * them, so a dedicated officer only gets enquiries from the rule that names them.
 */
export function dedicatedOfficers(rules: RuleLike[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rules) {
    if (r.isActive && r.action.assignStrategy === 'specific' && r.action.assigneeId && !out.has(r.action.assigneeId))
      out.set(r.action.assigneeId, r.name);
  }
  return out;
}

export interface PoolPickInput {
  pool: string[];
  /** Where this pick starts in the pool (already advanced by one for the next pick). */
  cursor: number;
  isActive: (id: string) => boolean;
  mode: AssignmentMode;
  /** Open enquiries per officer (missing = 0). Unused for plain round-robin. */
  loads?: Map<string, number>;
  /** For capped_round_robin. */
  cap?: number;
}

/**
 * Chooses an officer from a rule's pool. `advance` is how many extra places the shared cursor must
 * move so the next pick starts after the chosen officer.
 */
export function pickFromPool(p: PoolPickInput): { userId: string; advance: number } | null {
  const load = (id: string) => p.loads?.get(id) ?? 0;
  const order = p.pool.map((id, i) => ({ id: p.pool[(p.cursor + i) % p.pool.length]!, step: i }));
  const active = order.filter((o) => p.isActive(o.id));
  if (active.length === 0) return null;

  const leastLoaded = () => {
    // Ties go to whoever is next in the rotation, so equally loaded officers take turns.
    const best = active.reduce((a, b) => (load(b.id) < load(a.id) ? b : a));
    return { userId: best.id, advance: best.step };
  };

  if (p.mode === 'least_loaded') return leastLoaded();
  const cap = p.mode === 'capped_round_robin' ? (p.cap ?? Infinity) : Infinity;
  const next = active.find((o) => load(o.id) < cap);
  return next ? { userId: next.id, advance: next.step } : leastLoaded();
}
