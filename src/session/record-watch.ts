import { createRefusalFollower, type RecordNews, type Refusal } from './transcript.js';
import { gateRefusals, type RefusalGate } from './refusal-gate.js';
import { readLiveConversation } from './live-conversation.js';
import type { RecordedRefusal } from './refused-turn.js';

/**
 * Following a running Claude by its own records, as every launch that acts
 * on a refused turn while Claude runs does it: which conversation Claude says
 * the process is in (live-conversation), what that conversation's record has
 * gained (transcript), and when somebody last typed a prompt. A refused turn
 * then reaches the check with what tells whether it is the turn in front of
 * this Claude now (refused-turn).
 */

export interface RecordWatchOptions {
  /** The Claude's CLAUDE_CONFIG_DIR, where it keeps both records. */
  configDir: string;
  /**
   * Whether its launch starts a new conversation. Everything in that record
   * is this launch's, so it is read whole; a resumed one's history is not news.
   */
  startsNew: boolean;
  /** When the Claude was started. */
  launchedAt: number;
  /**
   * The conversation the launch resumes by id, when it names one and the
   * watch is made as Claude starts. Its record is then read from where it
   * ends at launch, so a turn Claude refuses before its own per-process record
   * has been read is still news.
   */
  resumes?: string | null;
  gate?: RefusalGate;
}

/** A refused turn as the watch read it, with the conversation whose record it was in. */
export interface ReadRefusal extends Refusal {
  conversation: string | null;
}

/** What the record of the conversation followed gained, each refusal with where it was read. */
export interface WatchNews extends RecordNews {
  refusals: ReadRefusal[];
}

export interface RecordWatch {
  /**
   * Ask Claude which conversation the process `pid` is in now, and follow it
   * there. The id when that changed since the last look, else null.
   */
  noteConversation(pid: number): string | null;
  /** The conversation followed, or null until Claude has said. */
  conversation(): string | null;
  /** What the record of the conversation followed gained since the last look. */
  poll(): WatchNews;
  /** When a prompt was last typed, by Claude's clock, among everything read; 0 before any. */
  promptAt(): number;
  /**
   * `refusal` as the check takes it, for the Claude process `claudePid`. A
   * refusal held back is asked about later, when Claude may have moved to
   * another conversation (a /clear): it is judged on the one it was read
   * from, and against the last prompt typed as things are now.
   */
  recorded(refusal: ReadRefusal, claudePid: number | null): RecordedRefusal;
}

export function createRecordWatch(options: RecordWatchOptions): RecordWatch {
  const follower = gateRefusals(createRefusalFollower(options.configDir, options.startsNew), options.gate);
  let conversation: string | null = null;
  let promptAt = 0;
  if (options.resumes) {
    conversation = options.resumes;
    // The first look at a record that is there takes its end: this is that look.
    follower.poll(conversation);
  }
  return {
    noteConversation(pid) {
      const id = readLiveConversation(options.configDir, pid, options.launchedAt);
      if (!id || id === conversation) return null;
      conversation = id;
      return id;
    },
    conversation: () => conversation,
    poll() {
      const news = follower.poll(conversation);
      // Kept before the refusals are handed on: one that a prompt read with it
      // came before is judged against that prompt.
      if (news.promptAt !== null) promptAt = Math.max(promptAt, news.promptAt);
      return { ...news, refusals: news.refusals.map((refusal) => ({ ...refusal, conversation })) };
    },
    promptAt: () => promptAt,
    recorded: (refusal, claudePid) => ({
      refusal,
      launchedAt: options.launchedAt,
      promptAt,
      conversation: refusal.conversation,
      claudePid,
    }),
  };
}
