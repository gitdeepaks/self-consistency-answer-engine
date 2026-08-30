#!/usr/bin/env bun
import {
  disconnect,
  getKillSwitch,
  globalSpendSince,
  releaseKillSwitch,
  engageKillSwitch,
  spendByTenant,
} from "@sce/db";
import {
  closeRedis,
  listDeadLetters,
  purgeDeadLetters,
  queueDepths,
  replayAllDeadLetters,
  replayDeadLetter,
  type DeadLetterQueueName,
} from "@sce/queue";
import {
  dayStart,
  formatMicroCentsUsd,
  GLOBAL_SPEND_SWITCH,
  describeError,
} from "@sce/shared";
import { z } from "zod";
import { reapOnce } from "./reaper.ts";
import { rollupOnce } from "./rollup.ts";

/**
 * Operator commands.
 *
 * Phase 2 asks for "a documented operator command" that replays dead letters.
 * This is it, and it is a real program rather than a paragraph in a runbook —
 * the difference between a procedure somebody can follow at 3am and one they
 * have to reconstruct from prose while an incident is running.
 *
 *   bun run --filter @sce/worker dlq depth
 *   bun run --filter @sce/worker dlq list [--limit 20]
 *   bun run --filter @sce/worker dlq replay <queue> <jobId>
 *   bun run --filter @sce/worker dlq replay-all [--limit 100]
 *   bun run --filter @sce/worker dlq purge [--older-than 2026-08-01]
 *   bun run --filter @sce/worker dlq reap
 */

const USAGE = `sce-worker — operator commands

  depth                          queue depths across both queues
  list [--limit N]               failed jobs, newest first
  replay <queue> <jobId>         put one failed job back on its queue
  replay-all [--limit N]         put every failed job back
  purge [--older-than ISO-DATE]  discard failed jobs permanently
  reap                           fail runs that are past their deadline

  spend [--days N] [--limit N]   today's spend, and the biggest spenders
  rollup                         recompute today's and yesterday's usage rollups
  halt --reason "..."            stop the install from starting new runs
  resume                         release the spend kill switch

Queue names are printed by \`list\`.`;

const limitSchema = z.coerce.number().int().positive().max(10_000);
const dateSchema = z.coerce.date();

/** Read `--flag value` out of the argument list. */
function flag(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

function parseCount(
  argv: readonly string[],
  name: string,
  fallback: number,
): number {
  const raw = flag(argv, name);
  if (raw === null) return fallback;
  const parsed = limitSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(`--${name} must be a positive integer, got ${raw}`);
  return parsed.data;
}

function parseLimit(argv: readonly string[], fallback: number): number {
  return parseCount(argv, "limit", fallback);
}

async function main(argv: readonly string[]): Promise<number> {
  const [command = "help", ...rest] = argv;

  switch (command) {
    case "depth": {
      for (const depth of await queueDepths()) {
        console.log(
          `${depth.queue.padEnd(20)} waiting ${depth.waiting}  active ${depth.active}  ` +
            `delayed ${depth.delayed}  waiting-children ${depth.waitingChildren}  ` +
            `failed ${depth.failed}  completed ${depth.completed}`,
        );
      }
      return 0;
    }

    case "list": {
      const letters = await listDeadLetters({ limit: parseLimit(rest, 50) });
      if (letters.length === 0) {
        console.log("Dead-letter queue is empty.");
        return 0;
      }
      for (const letter of letters) {
        console.log(
          `${letter.failedAt ?? "unknown time"}  ${letter.queue}  ${letter.jobId}\n` +
            `  attempts ${letter.attemptsMade}  data ${JSON.stringify(letter.data)}\n` +
            `  reason   ${letter.failedReason}`,
        );
      }
      console.log(`\n${letters.length} dead letter(s).`);
      return 0;
    }

    case "replay": {
      const [queue, jobId] = rest;
      if (queue === undefined || jobId === undefined) {
        console.error("usage: dlq replay <queue> <jobId>");
        return 2;
      }
      // The queue name is checked against the live queues rather than a
      // hard-coded list, so a typo fails here instead of silently doing nothing.
      const known = (await queueDepths()).map((depth) => depth.queue);
      if (!isKnownQueue(queue, known)) {
        console.error(
          `unknown queue ${queue}; expected one of ${known.join(", ")}`,
        );
        return 2;
      }
      const replayed = await replayDeadLetter(queue, jobId);
      console.log(
        replayed ? `Replayed ${jobId}.` : `No failed job ${jobId} on ${queue}.`,
      );
      return replayed ? 0 : 1;
    }

    case "replay-all": {
      const count = await replayAllDeadLetters({
        limit: parseLimit(rest, 100),
      });
      console.log(`Replayed ${count} dead letter(s).`);
      return 0;
    }

    case "purge": {
      const raw = flag(rest, "older-than");
      let olderThan: Date | undefined;
      if (raw !== null) {
        const parsed = dateSchema.safeParse(raw);
        if (!parsed.success)
          throw new Error(`--older-than must be a date, got ${raw}`);
        olderThan = parsed.data;
      }
      const count = await purgeDeadLetters(olderThan);
      console.log(`Purged ${count} dead letter(s).`);
      return 0;
    }

    case "reap": {
      const count = await reapOnce();
      console.log(`Reaped ${count} overdue run(s).`);
      return 0;
    }

    /*
     * The cost dashboard, until Phase 5 draws one.
     *
     * Everything an operator needs during a spend incident: what the install
     * has spent today against its cap, whether the kill switch has already
     * tripped, and which tenants the money went to. Printed rather than served,
     * because the moment it is most needed is the moment a web UI is least
     * likely to be reachable.
     */
    case "spend": {
      const days = parseCount(rest, "days", 1);
      const since = new Date(dayStart().getTime() - (days - 1) * 24 * 60 * 60 * 1000);
      const scope = {
        kind: "every-tenant",
        reason: "the global spend guard measures the whole install",
      } as const;

      const [total, killSwitch, tenants] = await Promise.all([
        globalSpendSince({ since, scope }),
        getKillSwitch(GLOBAL_SPEND_SWITCH),
        spendByTenant({ scope, from: since, limit: parseCount(rest, "limit", 20) }),
      ]);

      console.log(`since ${since.toISOString()}  total ${formatMicroCentsUsd(total, 2)}`);
      console.log(
        `kill switch: ${
          killSwitch.engaged
            ? `ENGAGED at ${killSwitch.engagedAt ?? "unknown"} — ${killSwitch.reason ?? "no reason recorded"}`
            : "released"
        }`,
      );
      if (tenants.length === 0) {
        console.log("no metered usage in the window.");
        return 0;
      }
      console.log("");
      for (const tenant of tenants) {
        console.log(
          `${tenant.slug.padEnd(24)} ${formatMicroCentsUsd(tenant.costMicroCents, 2).padStart(10)}  ` +
            `calls ${String(tenant.calls).padStart(6)}  ` +
            `tokens ${tenant.inputTokens + tenant.outputTokens}`,
        );
      }
      return 0;
    }

    case "rollup": {
      const rows = await rollupOnce();
      console.log(`Recomputed ${rows} rollup row(s).`);
      return 0;
    }

    /*
     * Stopping and starting the install by hand.
     *
     * The budget guard trips the same switch automatically; these exist for the
     * cases it cannot see — a provider incident, an abuse report, a bad deploy
     * — and for releasing it afterwards, which nothing automatic ever does.
     */
    case "halt": {
      const reason = flag(rest, "reason");
      if (reason === null) {
        console.error('usage: halt --reason "why the install is stopped"');
        return 2;
      }
      const killSwitch = await engageKillSwitch(GLOBAL_SPEND_SWITCH, reason);
      console.log(`Kill switch engaged at ${killSwitch.engagedAt ?? "now"}: ${reason}`);
      return 0;
    }

    case "resume": {
      const killSwitch = await releaseKillSwitch(GLOBAL_SPEND_SWITCH);
      console.log(`Kill switch released at ${killSwitch.releasedAt ?? "now"}.`);
      console.log(
        "New runs are accepted again. Workers pick this up within " +
          "KILL_SWITCH_REFRESH_MS, and the API within GLOBAL_BUDGET_REFRESH_MS.",
      );
      return 0;
    }

    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;

    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

/** Narrow a user-supplied string to a queue that actually exists. */
function isKnownQueue(
  candidate: string,
  known: readonly DeadLetterQueueName[],
): candidate is DeadLetterQueueName {
  return known.some((queue) => queue === candidate);
}

if (import.meta.main) {
  let code = 0;
  try {
    code = await main(process.argv.slice(2));
  } catch (error) {
    console.error(describeError(error));
    code = 1;
  } finally {
    await closeRedis();
    await disconnect();
  }
  process.exit(code);
}
