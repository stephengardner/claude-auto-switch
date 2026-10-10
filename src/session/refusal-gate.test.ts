import { describe, it, expect } from 'vitest';
import { gateRefusals, type RefusalGate } from './refusal-gate.js';
import type { Refusal, RefusalFollower } from './transcript.js';

const refusal = (at: number | null): Refusal => ({
  error: 'rate_limit',
  apiError: null,
  status: 429,
  text: 'Out of room for now.',
  at,
});

/** A record that hands over, on each look, whatever was written since the last one. */
function recordOf(): { follower: RefusalFollower; write: (r: Refusal) => void; looks: () => number } {
  let waiting: Refusal[] = [];
  let looks = 0;
  return {
    follower: {
      poll: () => {
        looks += 1;
        const refusals = waiting;
        waiting = [];
        return { readable: true, refusals };
      },
    },
    write: (r) => waiting.push(r),
    looks: () => looks,
  };
}

describe('holding refused turns back', () => {
  it('changes nothing with no gate', () => {
    const record = recordOf();
    expect(gateRefusals(record.follower, undefined)).toBe(record.follower);
  });

  it('does not read the record at all while held, so what was written waits', () => {
    const record = recordOf();
    let held = true;
    const gate: RefusalGate = { held: () => held, ignores: () => false };
    const gated = gateRefusals(record.follower, gate);
    record.write(refusal(1_000));
    expect(gated.poll('id')).toEqual({ readable: false, refusals: [] });
    expect(record.looks()).toBe(0);
    held = false;
    expect(gated.poll('id').refusals).toEqual([refusal(1_000)]);
  });

  it('says the record is as readable as it last was while held, so nothing else stands in for it', () => {
    const record = recordOf();
    let held = false;
    const gated = gateRefusals(record.follower, { held: () => held, ignores: () => false });
    expect(gated.poll('id').readable).toBe(true);
    held = true;
    expect(gated.poll('id')).toEqual({ readable: true, refusals: [] });
  });

  it('drops the turns the gate says to pass over, and keeps the rest in order', () => {
    const record = recordOf();
    const gate: RefusalGate = { held: () => false, ignores: (r) => r.at !== null && r.at >= 2_000 && r.at <= 3_000 };
    const gated = gateRefusals(record.follower, gate);
    for (const at of [1_999, 2_000, 2_500, 3_000, 3_001, null]) record.write(refusal(at));
    expect(gated.poll('id').refusals.map((r) => r.at)).toEqual([1_999, 3_001, null]);
  });
});
