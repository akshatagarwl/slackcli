import { describe, expect, it } from 'bun:test';
import { CliError, NotFoundError } from './cli-errors.ts';
import { fetchTranscript, parseVtt, transcriptText, transcriptUrl } from './transcript.ts';
import type { SlackClient } from './slack-client.ts';
import type { SlackFile } from '../types/index.ts';

const VTT_URL = 'https://files.slack.com/files-tmb/T0123456789-F0123456789-abc123/file.vtt';

// The shape Slack returns for an audio clip: a short preview plus the VTT URL.
const CLIP: SlackFile = {
  id: 'F0123456789',
  name: 'audio_clip.m4a',
  mimetype: 'audio/mp4',
  transcription: { status: 'complete', locale: 'en-US', preview: { content: 'Morning all,', has_more: true } },
  vtt: VTT_URL,
};

const SAMPLE_VTT = [
  'WEBVTT ',
  '',
  '00:00:00.600 --> 00:00:04.120',
  '- Morning all, quick update on',
  '',
  '00:00:04.120 --> 00:00:08.900',
  'the release: it moves to Thursday.',
  '',
].join('\n');

function fakeClient(body: string | Error): { client: SlackClient; urls: string[] } {
  const urls: string[] = [];
  const client = {
    downloadFile: (url: string) => {
      urls.push(url);
      return body instanceof Error ? Promise.reject(body) : Promise.resolve(body);
    },
  } as unknown as SlackClient;
  return { client, urls };
}

describe('parseVtt', () => {
  it('reads each cue with its timestamps, as Slack writes them', () => {
    expect(parseVtt(SAMPLE_VTT)).toEqual([
      { start: '00:00:00.600', end: '00:00:04.120', text: '- Morning all, quick update on' },
      { start: '00:00:04.120', end: '00:00:08.900', text: 'the release: it moves to Thursday.' },
    ]);
  });

  it('handles CRLF, a BOM, header metadata, cue identifiers and cue settings', () => {
    const vtt = '\uFEFFWEBVTT - captions\r\nKind: captions\r\n\r\n'
      + 'intro\r\n00:01.000 --> 00:02.500 align:start position:10%\r\nHello\r\n\r\n'
      + '01:00:00.000 --> 01:00:01.000\r\nworld\r\n';
    expect(parseVtt(vtt)).toEqual([
      { start: '00:01.000', end: '00:02.500', text: 'Hello' },
      { start: '01:00:00.000', end: '01:00:01.000', text: 'world' },
    ]);
  });

  it('joins multi-line cues and strips tags and entities', () => {
    const vtt = 'WEBVTT\n\n00:00.000 --> 00:01.000\n<v Ana>Fish &amp; chips</v>\n<i>at&nbsp;noon</i> &lt;3\n';
    expect(parseVtt(vtt)).toEqual([{ start: '00:00.000', end: '00:01.000', text: 'Fish & chips at noon <3' }]);
  });

  it('skips NOTE, STYLE and REGION blocks, empty cues and malformed timing lines', () => {
    const vtt = [
      'WEBVTT',
      '',
      'NOTE a comment with --> an arrow',
      '',
      'STYLE',
      '::cue { color: red }',
      '',
      '00:00.000 --> 00:01.000',
      '<b></b>',
      '',
      '0:00 --> 0:01',
      'not a valid timestamp',
      '',
      '00:01.000 --> 00:02.000',
      'kept',
    ].join('\n');
    expect(parseVtt(vtt)).toEqual([{ start: '00:01.000', end: '00:02.000', text: 'kept' }]);
  });

  it('returns no cues for a VTT with only a header', () => {
    expect(parseVtt('WEBVTT\n')).toEqual([]);
    expect(parseVtt('WEBVTT')).toEqual([]);
  });

  it('refuses a body that is not WebVTT', () => {
    for (const body of ['', '<html></html>', 'WEBVTTX\n', '1\n00:00:01,000 --> 00:00:02,000\nsrt']) {
      expect(() => parseVtt(body)).toThrow('The transcript is not a WebVTT file');
    }
  });
});

describe('transcriptText', () => {
  it('joins the cue texts with single spaces', () => {
    expect(transcriptText(parseVtt(SAMPLE_VTT)))
      .toBe('- Morning all, quick update on the release: it moves to Thursday.');
    expect(transcriptText([])).toBe('');
  });
});

describe('transcriptUrl', () => {
  it('returns the VTT URL of a complete transcript', () => {
    expect(transcriptUrl(CLIP)).toBe(VTT_URL);
  });

  it('is not_found for a file Slack does not transcribe', () => {
    const { transcription: _, vtt: __, ...pdf } = CLIP;
    expect(() => transcriptUrl(pdf)).toThrow(NotFoundError);
    expect(() => transcriptUrl(pdf)).toThrow('This file has no transcript');
  });

  it('names the status when the transcript is not finished, with a retry hint while processing', () => {
    let err: unknown;
    try {
      transcriptUrl({ ...CLIP, transcription: { status: 'processing' } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as NotFoundError).message).toBe('The transcript is not available (status: processing)');
    expect((err as NotFoundError).hint).toContain('retry');

    expect(() => transcriptUrl({ ...CLIP, transcription: { status: 'failed' } }))
      .toThrow('The transcript is not available (status: failed)');
    expect(() => transcriptUrl({ ...CLIP, transcription: {} }))
      .toThrow('The transcript is not available (status: unknown)');
  });

  it('is not_found when a complete transcript has no VTT URL', () => {
    const { vtt: _, ...noVtt } = CLIP;
    expect(() => transcriptUrl(noVtt)).toThrow('Slack did not return a transcript URL for this file');
  });
});

describe('fetchTranscript', () => {
  it('downloads the VTT and returns it with its cues and text', async () => {
    const { client, urls } = fakeClient(SAMPLE_VTT);
    const progress: string[] = [];
    const transcript = await fetchTranscript(client, CLIP, (message) => progress.push(message));
    expect(urls).toEqual([VTT_URL]);
    expect(progress).toEqual(['Downloading transcript...']);
    expect(transcript.vtt).toBe(SAMPLE_VTT);
    expect(transcript.cues).toHaveLength(2);
    expect(transcript.text).toBe('- Morning all, quick update on the release: it moves to Thursday.');
  });

  it('does not download anything for a file without a finished transcript', async () => {
    const { client, urls } = fakeClient(SAMPLE_VTT);
    await expect(fetchTranscript(client, { ...CLIP, transcription: { status: 'processing' } }))
      .rejects.toBeInstanceOf(NotFoundError);
    expect(urls).toEqual([]);
  });

  it('reports an expired session when Slack answers with its sign-in page', async () => {
    const { client } = fakeClient('<html><title>Sign in | Slack</title></html>');
    const err = await fetchTranscript(client, CLIP).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe('auth_failed');
  });

  it('does not mistake spoken words for a sign-in page', async () => {
    // Raw tag-like text inside a cue would match the sign-in check on its own.
    const { client } = fakeClient('WEBVTT\n\n00:00.000 --> 00:01.000\nthe <title>Sign in</title> page\n');
    expect((await fetchTranscript(client, CLIP)).text).toBe('the Sign in page');
  });

  it('passes download failures through unchanged', async () => {
    const { client } = fakeClient(new Error('Download failed: HTTP 404'));
    await expect(fetchTranscript(client, CLIP)).rejects.toThrow('Download failed: HTTP 404');
  });
});
