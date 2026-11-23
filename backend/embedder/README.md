# @openfolia/embedder

The local embedding worker for semantic search (#532): a small multilingual sentence-embedding
model on [ONNX Runtime](https://onnxruntime.ai) (`onnxruntime-node` 1.27.0, MIT), on the CPU,
behind the endpoint the API's `HttpEmbedder` calls. So semantic search runs without any text
leaving the installation. The tokenizer is `@huggingface/tokenizers` 0.2.0 (Apache-2.0, pure
JavaScript, no dependencies). No model ships with it: the model is configuration. ONNX Runtime's
npm package carries no licence file, and its native library contains third-party code: its
licence and those notices are in `licenses/` (from the same release's Python package) and in the
image.

It is its own process (and image), not part of the API: one model loaded once, its memory and
CPU bounded apart from the API's. The API reaches it like any embeddings endpoint
(`CCMS_EMBEDDER_URL`, `backend/api/README.md`, "Postgres search"), so the API or the workers can
use it from wherever they run, and another endpoint can replace it.

## Running it

```sh
pnpm nx build embedder
CCMS_EMBEDDER_MODEL=my-model CCMS_EMBEDDER_DIMENSIONS=384 \
CCMS_EMBEDDER_MODEL_DIR=./model \
CCMS_EMBEDDER_MODEL_SHA256=$(shasum -a 256 model/model.onnx | cut -d' ' -f1) \
CCMS_EMBEDDER_TOKENIZER_SHA256=$(shasum -a 256 model/tokenizer.json | cut -d' ' -f1) \
node backend/embedder/dist/main.js
# then, for the API: CCMS_EMBEDDER_URL=http://127.0.0.1:8090/v1/embeddings, the same _MODEL and _DIMENSIONS
```

In a deployment: `deploy/compose.embedder.yaml` (`deploy/README.md`, "Semantic search").

| Setting                          | What                                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `CCMS_EMBEDDER_MODEL`            | the model's name, the API's `CCMS_EMBEDDER_MODEL`: a request naming another is refused (required)        |
| `CCMS_EMBEDDER_DIMENSIONS`       | the length of its vectors, 1-2000, checked as the model loads (required)                                 |
| `CCMS_EMBEDDER_MODEL_DIR`        | the folder with `model.onnx` and `tokenizer.json` (default `/models`)                                    |
| `CCMS_EMBEDDER_MODEL_SHA256`     | the SHA-256 of `model.onnx`; another file is refused (required)                                          |
| `CCMS_EMBEDDER_TOKENIZER_SHA256` | the SHA-256 of `tokenizer.json`; another file is refused (required)                                      |
| `CCMS_EMBEDDER_POOLING`          | `mean` (default) or `cls`: how a text's token vectors become one                                         |
| `CCMS_EMBEDDER_PREFIX`           | text put before every input, for a model that expects one (default none)                                 |
| `CCMS_EMBEDDER_MAX_TOKENS`       | the most tokens of a text the model reads (8-2048; default: the tokenizer's truncation length, else 512) |
| `CCMS_EMBEDDER_THREADS`          | CPU threads per model run (default 2)                                                                    |
| `CCMS_EMBEDDER_QUEUE`            | requests waiting while one runs (0-64, default 8); one more is 503 with `Retry-After`                    |
| `CCMS_EMBEDDER_HOST`, `_PORT`    | where it listens (default `127.0.0.1:8090`; the image `0.0.0.0:8090`)                                    |

A missing or malformed setting stops the start with its name, never its value (`.env.example`,
"Embedding worker").

## The model

Any sentence-embedding model exported to ONNX with a `tokenizer.json`, that:

- is **multilingual** (the content's languages; a model for one language finds paraphrases in
  that one only), and made for **sentence embeddings** (similar meaning, close vectors; a plain
  language model's token states are not that);
- answers vectors of **at most 2,000 numbers** (pgvector's HNSW index takes no more);
- takes `input_ids`, and optionally `attention_mask` and `token_type_ids` (int64), and answers
  `sentence_embedding` (one vector per text) or `last_hidden_state` (one per token, pooled here
  by `CCMS_EMBEDDER_POOLING`); otherwise its first output;
- is under a licence that lets you run it (it is never distributed with this software).

Small models of this kind (about 100 million parameters, 384 dimensions, 120 to 470 MB) embed a
search index on a few CPU cores in minutes and answer a query in a few milliseconds. Pick the
pooling and the prefix the model's card names. The guide's page, "Search and semantic search",
says how to install one.

## How it works

- **Start:** reads `model.onnx` and `tokenizer.json`, refuses either unless its SHA-256 is the
  pinned one (the bytes checked are the bytes loaded), creates one ONNX Runtime session on the
  CPU execution provider (`CCMS_EMBEDDER_THREADS` threads, all graph optimisations), embeds one
  text and refuses a model whose vectors are not `CCMS_EMBEDDER_DIMENSIONS` long or that takes
  an input it cannot give. Only then does it listen.
- **`POST /v1/embeddings`** takes `{ "model", "input": [texts] }` (one text as a string too;
  `encoding_format` only `float`) and answers
  `{ "object": "list", "data": [{ "object": "embedding", "index", "embedding" }], "model", "usage" }`.
  At most 32 texts of 4,000 characters (what `HttpEmbedder` sends) and 1 MiB of body (read up
  to that, a longer one is 413 unread); the request must arrive within 30 s. Errors are
  `{ "error": { "message", "type" } }` (400 `invalid_request_error`, 413, 415, 404, 405,
  503 `server_busy`, 500 `model_error`) and never hold the text. `GET /health` is 200.
- **One at a time:** one request runs at once, `CCMS_EMBEDDER_QUEUE` more wait in order, then
  503 with `Retry-After: 1`; open connections are capped at the queue plus 8 (each may buffer a
  body of up to 1 MiB), and slow clients are checked every 2 s; a request whose caller hung up while it waited is not run. Within a
  request, texts are tokenized, cut at `CCMS_EMBEDDER_MAX_TOKENS` (keeping the closing special
  token), sorted by length and run in groups of at most 8,192 tokens (`MAX_BATCH_TOKENS`, so 32
  long texts never need the attention memory of all of them at once), pooled over the tokens the
  mask holds (padding never counts) and scaled to unit length.
- **Logs** go to stderr: the start, and a failed run by its error, never a text.
- **No authentication:** it is reached on the deployment's internal network only
  (`deploy/compose.embedder.yaml`: no published port, a network without a route out). Do not
  publish its port.

## No network

Nothing in the worker makes a network call: no model download (the files are mounted or baked
into an image, a person fetches them once), no telemetry.

- **ONNX Runtime 1.27.0, pinned.** Version 1.29 added a usage-data client to the Linux and macOS
  libraries (a collector endpoint, a device ID, uploads, unless `ORT_DISABLE_TELEMETRY` is set).
  1.27.0's libraries have none: checked in the npm package's binaries, whose Linux library does
  not even import `socket`, `connect` or `getaddrinfo` (`objdump -T`), and has no collector
  endpoint or telemetry client in its strings. `runtime-check.ts` (`--check-runtime`, run by
  the image's build and by a test) fails on a library holding that client's markers, so a
  version bump that brings it back fails. The check is a marker scan, so defence in depth: the
  exact pin (with the lockfile's integrity hash), the internal network and
  `ORT_DISABLE_TELEMETRY=1` (set anyway) are the controls.
- **Its install script never runs** (`pnpm-workspace.yaml`, `allowBuilds`: it downloads GPU
  libraries); the image drops it, the packages only it uses, and the other platforms'
  libraries.
- **The tokenizer** has no network code (no `fetch`, `http` or `net`).
- **The deployment** puts the worker on an internal Docker network, so even a call would have
  nowhere to go.

## Tests

`pnpm nx test embedder`: the settings, the batching and pooling, the server against a fake model
(`tests/fake-model.ts`), and the ONNX Runtime for real on a tiny model the tests write
(`tests/fixture-model.ts`: one `Gather` over a fixed table and a WordPiece tokenizer of a few
words), so the default suite loads no large model and takes about a second.

**Testing with a real model** (opt-in, `tests/real-model.spec.ts`): paraphrases, also across
languages, closer than unrelated text.

```sh
CCMS_EMBEDDER_TEST_MODEL_DIR=/path/to/model CCMS_EMBEDDER_TEST_DIMENSIONS=384 pnpm nx test embedder
# a model that expects a prefix: CCMS_EMBEDDER_TEST_PREFIX="query: "
```
