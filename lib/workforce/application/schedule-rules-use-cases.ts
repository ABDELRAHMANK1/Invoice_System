/**
 * Schedule-rules use cases. A client that has never saved rules reads the
 * defaults (DEFAULT_SCHEDULE_RULES) instead of a 404 — the generator always has
 * a coherent rule set to work with.
 */

import type { ScheduleRules, ScheduleRulesInput, ScheduleRulesRepository } from "@/lib/workforce/domain";
import type { ClientRateRepository } from "@/lib/workforce/domain";
import { scheduleRulesError, scheduleRulesOrDefaults } from "@/lib/workforce/domain";
import { NotFoundError, ValidationError } from "./errors";

export interface ScheduleRulesDeps {
  rules: ScheduleRulesRepository;
  clients: ClientRateRepository;
}

export async function getScheduleRules(
  deps: Pick<ScheduleRulesDeps, "rules">,
  clientId: string,
): Promise<ScheduleRules> {
  return scheduleRulesOrDefaults(clientId, await deps.rules.findByClient(clientId));
}

export async function saveScheduleRules(
  deps: ScheduleRulesDeps,
  clientId: string,
  input: ScheduleRulesInput,
): Promise<ScheduleRules> {
  const error = scheduleRulesError(input);
  if (error) throw new ValidationError(error);
  // Checked here so an upsert against a deleted client surfaces as a 404 rather
  // than a raw foreign-key violation.
  if (!(await deps.clients.exists(clientId))) throw new NotFoundError("Client");
  return deps.rules.save(clientId, input);
}
