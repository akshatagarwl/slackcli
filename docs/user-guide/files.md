# Inspect, read and download Slack files

`slackcli files` inspects metadata, prints textual content, and downloads
Slack-hosted files. Every command accepts a file ID or Slack file URL.

`files info`, `files read` and `files transcript` take [`--fields`](scripting.md#keeping-output-small---fields-and---limit) with
`--json` to print only the fields you name (`files info F1234567890 --json --fields id,name,size`).

Reading files requires the `files:read` scope when you use standard
authentication. Browser-session authentication uses the existing browser cookie
and token.

## `files info`

```bash
slackcli files info F1234567890
slackcli files info https://myteam.slack.com/files/U123/F1234567890/report.txt
slackcli files info F1234567890 --json
```

Human-readable output includes the file ID, name, type, size, owner, creation
time, and permalink when Slack provides them. It does not print private download
URLs.

`--json` returns the complete file object from Slack. This can include
`url_private` and `url_private_download`, so treat the output as private.

## `files read`

```bash
# Print textual content
slackcli files read F1234567890

# Read Slack's plain-text extraction from an email file
slackcli files read F1234567890

# Read the original textual file instead of Slack's extraction
slackcli files read F1234567890 --raw

# Return the content and its source as JSON
slackcli files read F1234567890 --json
```

Slack email files can include a `plain_text` field in their metadata. The
command uses that field by default. Otherwise, it downloads the original when
the MIME type identifies a textual file.

`--raw` always reads the original textual file. Text reads are capped at 10 MB.
The command refuses to print binary files; use `files download` for those.

JSON output has this shape:

```json
{
  "id": "F1234567890",
  "name": "message.eml",
  "title": "Message",
  "mimetype": "message/rfc822",
  "source": "plain_text",
  "content": "From: sender@example.com\n..."
}
```

`source` is `plain_text` or `original`.

## `files transcript`

```bash
# Print the full transcript of an audio or video clip
slackcli files transcript F1234567890

# Print Slack's WebVTT, with a timestamp on every cue
slackcli files transcript F1234567890 --format vtt

# Return every cue and the joined text as JSON
slackcli files transcript F1234567890 --json
```

Slack transcribes audio and video clips. `files info` shows only a short
preview of the transcript (`transcription.preview`, with `has_more: true` when
it is cut). This command downloads the complete transcript, the WebVTT file the
file object links in its `vtt` field, and prints its text: every cue in order,
joined with single spaces. `--format vtt` prints the VTT unchanged instead.

The command fails with `not_found` when the file has no transcript (it is not
a clip) or Slack has not finished it (`transcription.status` is `processing`,
`failed`, …). Like `files read`, it reports `auth_failed` when Slack answers
with its sign-in page.

JSON output has this shape:

```json
{
  "id": "F1234567890",
  "name": "audio_clip.m4a",
  "title": "Audio clip",
  "locale": "en-US",
  "text": "Morning all, quick update on the release: it moves to Thursday.",
  "cues": [
    { "start": "00:00:00.600", "end": "00:00:04.120", "text": "Morning all, quick update on" },
    { "start": "00:00:04.120", "end": "00:00:08.900", "text": "the release: it moves to Thursday." }
  ]
}
```

`start` and `end` are the cue times exactly as the VTT writes them. `--json`
always carries the cues, so `--format vtt` cannot be combined with it.

## `files download`

```bash
slackcli files download F1234567890 --output ./report.pdf
slackcli files download "$FILE_URL" --output ./message.eml

# An output path outside the current directory needs confirmation
slackcli files download F1234567890 --output ~/Downloads/report.pdf --yes
```

The command streams the original bytes to the output path. It does not convert
binary data to text or hold the complete download in memory.

The output path is required. The command refuses to overwrite an existing file.
Choose another path or remove the existing file before you retry.

On macOS and Linux the downloaded file is created with mode `0600` (readable
by you only), whatever your umask, because Slack files are workspace content.
`chmod` it afterwards if you mean to share it. Windows uses the folder's ACLs.

### Output paths outside the current directory

`--output` writes wherever you point it, and SlackCLI is built to be driven by
AI agents, so the value can come from content an agent read out of Slack. A
path that stays inside the current working directory downloads exactly as
before, with no prompt. A path that escapes it — `../…`, an absolute path
outside it, or a directory symlinked out of the working tree — is confirmed
first:

- `--yes` proceeds.
- An interactive terminal prompts `y/N`.
- A non-interactive shell without `--yes` refuses and exits non-zero.

The message names the resolved absolute path, not the string you typed, and
names the symlink target as well when the two differ. Confirmation happens
before any Slack API call, so a declined download requests nothing.

This is a containment check, not a sandbox: `--yes` still writes anywhere you
have permission to write. See [Scripting](scripting.md) for unattended use.

## File URLs and workspaces

Supported URLs include normal Slack file permalinks, Canvas document URLs, and
private Slack file URLs. When a permalink names a different workspace from the
selected browser-authenticated workspace, SlackCLI warns before making the API
request. Use `--workspace <id|name>` to select the matching workspace.

Private `files.slack.com` URLs do not identify their workspace, so SlackCLI
cannot provide a workspace-mismatch warning for those URLs.
