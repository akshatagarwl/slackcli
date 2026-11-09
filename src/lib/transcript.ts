import { getLogger } from '@logtape/logtape';
import { isAuthPage } from './canvas-parser.ts';
import { CliError, NotFoundError } from './cli-errors.ts';
import type { SlackClient } from './slack-client.ts';
import type { SlackFile } from '../types/index.ts';

// Full transcripts of audio and video clips (#526). `files.info` returns only
// `transcription.preview`; the complete text is the WebVTT file Slack links
// from the file's `vtt` field once the transcription is complete.

const logger = getLogger(['slackcli', 'transcript']);

/** Transcripts are short text; the cap only guards against a wrong URL. */
const MAX_VTT_SIZE = 10 * 1024 * 1024;

export interface TranscriptCue {
  /** Cue start as written in the VTT (`00:00:05.448`). */
  start: string;
  /** Cue end as written in the VTT. */
  end: string;
  text: string;
}

export interface Transcript {
  vtt: string;
  cues: TranscriptCue[];
  /** Every cue's text, in order, joined with single spaces. */
  text: string;
}

type OnProgress = (message: string) => void;

// `mm:ss.ttt` or `hh:mm:ss.ttt`, then `-->`, then the end and optional cue settings.
const TIMING_LINE = /^((?:\d+:)?\d{2}:\d{2}\.\d{3})[ \t]+-->[ \t]+((?:\d+:)?\d{2}:\d{2}\.\d{3})(?:[ \t].*)?$/;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  lrm: '',
  rlm: '',
};

/** Cue payload to plain text: drop `<v Speaker>`, `<b>`, timestamp tags; decode entities. */
function cueText(lines: string[]): string {
  return lines
    .join(' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|apos|nbsp|lrm|rlm);/g, (_, name: string) => ENTITIES[name] ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse a WebVTT document into cues. NOTE, STYLE and REGION blocks and cue
 * identifiers are skipped; cues with no text are dropped. Throws when the
 * document does not start with the `WEBVTT` signature.
 */
function isVtt(text: string): boolean {
  const firstLine = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/, 1)[0] ?? '';
  return /^WEBVTT(?:[ \t].*)?$/.test(firstLine.trimEnd());
}

export function parseVtt(vtt: string): TranscriptCue[] {
  if (!isVtt(vtt)) throw new CliError('unknown', 'The transcript is not a WebVTT file');
  const lines = vtt.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);

  const cues: TranscriptCue[] = [];
  let block: string[] = [];
  const flush = () => {
    const timingIndex = block.findIndex((line) => line.includes('-->'));
    // A block whose first line is NOTE/STYLE/REGION, or that has no timing line, is not a cue.
    if (timingIndex !== -1 && timingIndex <= 1 && !/^(?:NOTE|STYLE|REGION)(?:\s|$)/.test(block[0] ?? '')) {
      const timing = TIMING_LINE.exec(block[timingIndex]!.trim());
      const text = cueText(block.slice(timingIndex + 1));
      if (timing && text) cues.push({ start: timing[1]!, end: timing[2]!, text });
    }
    block = [];
  };

  // Line 0 is the header; its block (header metadata) ends at the first blank line.
  let inHeader = true;
  for (const line of lines.slice(1)) {
    if (line.trim() === '') {
      if (!inHeader) flush();
      inHeader = false;
      continue;
    }
    if (inHeader) continue;
    block.push(line);
  }
  flush();
  return cues;
}

export function transcriptText(cues: TranscriptCue[]): string {
  return cues.map((cue) => cue.text).join(' ');
}

/**
 * Check that a file has a finished transcript and return its VTT URL. A file
 * that is not a clip, a transcript still processing, or a failed one is a
 * not_found error naming the state, never an empty transcript.
 */
export function transcriptUrl(file: SlackFile): string {
  const status = file.transcription?.status;
  if (!file.transcription) {
    throw new NotFoundError(
      'This file has no transcript',
      'Slack transcribes audio and video clips only.',
    );
  }
  if (status !== 'complete') {
    throw new NotFoundError(
      `The transcript is not available (status: ${status || 'unknown'})`,
      status === 'processing' ? 'Slack is still transcribing this clip; retry in a minute.' : undefined,
    );
  }
  if (!file.vtt) throw new NotFoundError('Slack did not return a transcript URL for this file');
  return file.vtt;
}

/** Download and parse a file's full transcript. */
export async function fetchTranscript(
  client: SlackClient,
  file: SlackFile,
  onProgress?: OnProgress,
): Promise<Transcript> {
  const url = transcriptUrl(file);
  onProgress?.('Downloading transcript...');
  const vtt = await client.downloadFile(url, MAX_VTT_SIZE);
  // Checked only for a non-VTT body, so spoken words can never trip it.
  if (!isVtt(vtt) && isAuthPage(vtt)) {
    throw new CliError('auth_failed', 'The downloaded content is a Slack sign-in page. Your token may have expired.');
  }
  const cues = parseVtt(vtt);
  logger.debug('Parsed transcript for {file_id}: {count} cues', { file_id: file.id, count: cues.length });
  return { vtt, cues, text: transcriptText(cues) };
}
