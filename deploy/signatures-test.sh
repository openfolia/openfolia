#!/bin/sh
# The install guide's signature check (#745: step 5, before anything is pulled), as the guide of a
# release words it, run on a release's files with a stand-in for cosign and for curl, and nothing
# else on its PATH: no network tool, no Docker. It shows that the check
#
# - with the release not signed (signing off: no DOCS_RELEASE_SIGNATURES), downloads nothing, runs
#   no cosign and says so;
# - without cosign installed, downloads nothing and says the signatures are not checked;
# - with the signatures good, downloads only the release's files (the trust root and a bundle per
#   image, each verified by the checksum the guide names), and runs cosign only as
#   `verify-blob-attestation` against the bundle and the release's trust root (`--trusted-root`),
#   which cosign verifies offline: nothing asks the transparency log, the certificate authority or
#   Sigstore's TUF repository, and no command beyond curl to the release's files could;
# - fails for a signature made for another digest, by another identity or issuer, a bundle the release lacks,
#   and a file that is not the one whose checksum the guide names, and checks nothing after a
#   failed download.
#
# The real cosign's offline verification of a bundle is cosign's own (`verify-blob-attestation
# --trusted-root`, sigstore-go's verifier); what this test holds is the guide's part: which
# files, which checksums, which flags, which digests and identity, and what it does on failure.
#
#   deploy/signatures-test.sh
set -eu

here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
work=$(mktemp -d)
tag=v9.9.9
images=registry.example.com/signatures-test/openfolia
# Never contacted: the stand-in for curl serves it from a folder.
release_url=http://127.0.0.1:9/release
identity="https://github.com/openfolia/openfolia/.github/workflows/images.yml@refs/tags/$tag"
issuer=https://token.actions.githubusercontent.com
predicate=https://sigstore.dev/cosign/sign/v1

cleanup() {
  status=$?
  rm -rf "$work"
  if [ "$status" = 0 ]; then echo "signatures-test: passed"; else echo "signatures-test: FAILED" >&2; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 1' INT TERM

fail() {
  echo "signatures-test: $*" >&2
  exit 1
}

sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

# The release: a digest per image, a trust root, and a bundle per image as the stand-in reads it.
mkdir -p "$work/served" "$work/tmp" "$work/install"
i=0
: >"$work/images.lock"
for image in api backup editor embedder mcp; do
  i=$((i + 1))
  echo "$images/$image:$tag@sha256:$(printf "%064d" "$i")" >>"$work/images.lock"
done
digest_of() { sed -n "s#^$images/$1:$tag@sha256:##p" "$work/images.lock"; }
echo "the release's trust root" >"$work/served/trusted_root.json"
# A bundle the stand-in cosign accepts only for this digest, identity and issuer.
bundle() {
  printf 'subject=%s\nidentity=%s\nissuer=%s\n' "$2" "${3:-$identity}" "${4:-$issuer}" >"$work/served/$1.sigstore.json"
}
for image in api backup editor embedder mcp; do bundle "$image" "$(digest_of "$image")"; done
sums() {
  for file in trusted_root.json api.sigstore.json backup.sigstore.json editor.sigstore.json embedder.sigstore.json mcp.sigstore.json; do
    echo "$(sha "$work/served/$file")  $file"
  done
}

# The step 5 signature check of the guide rendered with these settings, into check.sh.
render() {
  (cd "$root/frontend/docs" && DOCS_RELEASE="$tag" DOCS_SITE_URL=https://docs.example.com \
    DOCS_IMAGES="$images" DOCS_RELEASE_URL="$release_url" DOCS_RELEASE_DIGESTS="$(cat "$work/images.lock")" \
    DOCS_RELEASE_SIGNATURES="${1:-}" CHECK_OUT="$work/check.sh" node --input-type=module -e '
      import { readFileSync, writeFileSync } from "node:fs";
      import { checkAgentGuide, codeBlocks, guideValues, renderAgentGuide } from "./scripts/lib/agent-guide.mjs";
      import { docsSettings } from "./scripts/lib/settings.mjs";
      const settings = docsSettings(process.env);
      const values = guideValues(settings, readFileSync("../../deploy/compose.yaml", "utf8"), "en");
      const page = renderAgentGuide(readFileSync("agents/agents.mdx", "utf8"), values);
      const problems = checkAgentGuide(page, { english: true, rendered: true });
      if (problems.length) throw new Error(problems.join("\n"));
      const block = codeBlocks(page).find((b) => b.includes("verify-blob-attestation"));
      if (!block?.startsWith("cd ~/openfolia\n")) throw new Error("no signature check in step 5");
      writeFileSync(process.env.CHECK_OUT, block.slice("cd ~/openfolia\n".length));
    ')
}

# The only commands the check may run: the stand-ins, and the few tools it needs. Each stand-in
# logs its calls; curl serves only the release's folder, and cosign verifies only what a real
# bundle would let it, and refuses any other command or flag.
bin="$work/bin"
mkdir -p "$bin"
for tool in mktemp rm shasum sha256sum; do
  path=$(command -v "$tool" 2>/dev/null || true)
  [ -z "$path" ] || ln -s "$path" "$bin/$tool"
done
[ -e "$bin/mktemp" ] && [ -e "$bin/rm" ] || fail "no mktemp or rm"
[ -e "$bin/shasum" ] || fail "no shasum: the guide's check runs it"
cat >"$bin/curl" <<EOF
#!/bin/sh
echo "\$*" >>"$work/curl.log"
[ "\$1" = -fsSL ] && [ "\$2" = -o ] && [ \$# = 4 ] || { echo "curl: unexpected arguments" >&2; exit 2; }
case "\$4" in
  "$release_url"/*) file=\${4#"$release_url"/} ;;
  *) echo "curl: not a file of the release: \$4" >&2; exit 7 ;;
esac
case "\$file" in */* | .*) exit 22 ;; esac
[ -f "$work/served/\$file" ] || exit 22
$(command -v cp) "$work/served/\$file" "\$3"
EOF
cat >"$bin/cosign.stub" <<EOF
#!/bin/sh
echo "\$*" >>"$work/cosign.log"
[ "\$1" = verify-blob-attestation ] || { echo "cosign: unexpected command \$1" >&2; exit 99; }
shift
bundle= root= id= iss= type= digest= alg=
while [ \$# -gt 0 ]; do
  case "\$1" in
    --bundle) bundle=\$2 ;;
    --trusted-root) root=\$2 ;;
    --certificate-identity) id=\$2 ;;
    --certificate-oidc-issuer) iss=\$2 ;;
    --type) type=\$2 ;;
    --digest) digest=\$2 ;;
    --digestAlg) alg=\$2 ;;
    *) echo "cosign: unexpected flag \$1" >&2; exit 98 ;;
  esac
  shift 2
done
[ -n "\$root" ] && [ "\$($(command -v cat) "\$root")" = "the release's trust root" ] || { echo "Error: not the release's trust root" >&2; exit 1; }
[ "\$type" = "$predicate" ] && [ "\$alg" = sha256 ] || { echo "Error: not an image signature" >&2; exit 1; }
field() { $(command -v sed) -n "s/^\$1=//p" "\$bundle"; }
[ -f "\$bundle" ] && [ "\$(field subject)" = "\$digest" ] || { echo "Error: none of the subjects matches the digest" >&2; exit 1; }
[ "\$(field identity)" = "\$id" ] && [ "\$(field issuer)" = "\$iss" ] || { echo "Error: no matching certificate identity" >&2; exit 1; }
echo "Verified OK" >&2
EOF
chmod +x "$bin/curl" "$bin/cosign.stub"

# Runs the rendered check in a new installation folder, with or without cosign; its output in out.
check() {
  rm -f "$bin/cosign" "$work/curl.log" "$work/cosign.log"
  : >"$work/curl.log"
  : >"$work/cosign.log"
  [ "$1" = without-cosign ] || ln -s "$bin/cosign.stub" "$bin/cosign"
  (cd "$work/install" && /usr/bin/env -i PATH="$bin" HOME="$work" TMPDIR="$work/tmp" /bin/sh "$work/check.sh") >"$work/out" 2>&1 ||
    fail "the check itself failed: $(cat "$work/out")"
  cat "$work/out"
}
expect() { grep -qxF "$1" "$work/out" || fail "$2"; }
# A check that stops: its stop line, and never the line that lets the guide go on.
refused() {
  expect "a signature is not verified: stop" "$1"
  ! grep -qxF "every signature verified" "$work/out" || fail "$1, and said every signature verified"
}

echo "--- the release not signed (signing off): nothing downloaded, no cosign run"
render ""
check with-cosign
expect "this release is not signed: no signatures to check" "an unsigned release's check did not say so"
[ ! -s "$work/curl.log" ] && [ ! -s "$work/cosign.log" ] || fail "an unsigned release's check downloaded or ran something"

echo "--- signed, without cosign: nothing downloaded, the signatures not checked"
render "$(sums)"
check without-cosign
expect "no cosign: the signatures are not checked" "the check without cosign did not say so"
[ ! -s "$work/curl.log" ] || fail "the check without cosign downloaded something"

echo "--- signed, with cosign: every signature verified, offline, from the release's files only"
check with-cosign
expect "every signature verified" "good signatures fail the check"
for image in api editor backup mcp; do expect "$image: signature verified" "$image not verified"; done
[ "$(grep -c ': signature verified$' "$work/out")" = 4 ] || fail "not the four images compose.yaml runs"
[ "$(wc -l <"$work/curl.log" | tr -d ' ')" = 5 ] || fail "not the trust root and four bundles: $(cat "$work/curl.log")"
grep -Ev "^-fsSL -o ([a-z]+\.sigstore|trusted_root)\.json $release_url/([a-z]+\.sigstore|trusted_root)\.json$" "$work/curl.log" && fail "a download beyond the release's files"
[ "$(wc -l <"$work/cosign.log" | tr -d ' ')" = 4 ] || fail "cosign not run once per image"
while read -r line; do
  case "$line" in
    "verify-blob-attestation --bundle "*" --trusted-root "*"/trusted_root.json --certificate-identity $identity --certificate-oidc-issuer $issuer --type $predicate --digest "*" --digestAlg sha256") ;;
    *) fail "cosign run otherwise than offline against the release's trust root: $line" ;;
  esac
done <"$work/cosign.log"
grep -q -- "--digest $(digest_of editor) " "$work/cosign.log" || fail "not the digest the release pins for editor"

echo "--- a signature for another digest: the check fails"
bundle api "$(digest_of mcp)"
render "$(sums)"
check with-cosign
expect "api: signature NOT verified" "a signature for another digest passed"
refused "the check did not stop"

echo "--- a signature by another identity (another repository's workflow): the check fails"
bundle api "$(digest_of api)" "https://github.com/someone-else/openfolia/.github/workflows/images.yml@refs/tags/$tag"
render "$(sums)"
check with-cosign
expect "api: signature NOT verified" "a signature by another identity passed"
refused "the check did not stop"
bundle api "$(digest_of api)"

echo "--- a signature with another issuer: the check fails"
bundle api "$(digest_of api)" "$identity" https://issuer.example.com
render "$(sums)"
check with-cosign
expect "api: signature NOT verified" "a signature with another issuer passed"
refused "the check did not stop"
bundle api "$(digest_of api)"

echo "--- a bundle the release lacks: the check fails, and runs no cosign"
render "$(sums)"
mv "$work/served/mcp.sigstore.json" "$work/mcp.sigstore.json"
check with-cosign
refused "a missing bundle passed"
[ ! -s "$work/cosign.log" ] || fail "cosign ran after a failed download"
mv "$work/mcp.sigstore.json" "$work/served/mcp.sigstore.json"

echo "--- a file that is not the one the guide names: the check fails, and runs no cosign"
echo "another trust root" >"$work/served/trusted_root.json"
check with-cosign
refused "a file with another checksum passed"
[ ! -s "$work/cosign.log" ] || fail "cosign ran after a failed checksum"
