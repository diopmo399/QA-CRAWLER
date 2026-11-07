#!/usr/bin/env bash
# Reconstruit les dépôts Maven de test (jars compilés par javac contre des stubs d'annotations Spring).
# Le résultat est versionné : les tests ne demandent ni JDK ni Maven.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(dirname "$HERE")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
rm -rf "$OUT/m2" "$OUT/remote"
javac --release 17 -d "$TMP/stubs" $(find "$HERE/stubs" -name '*.java')
# install <repo> <artifact> <version> <javac options> <with sources jar?>
install() {
  local repo="$1" artifact="$2" version="$3" opts="$4" sources="$5"
  local dir="$OUT/$repo/com/acme/$artifact/$version" classes="$TMP/$artifact-$version"
  mkdir -p "$dir" "$classes"
  local cp="$TMP/stubs"
  [ -d "$TMP/common-api-1.0.0" ] && cp="$cp:$TMP/common-api-1.0.0"
  # shellcheck disable=SC2086
  javac --release 17 $opts -cp "$cp" -d "$classes" $(find "$HERE/src/$artifact-$version" -name '*.java')
  (cd "$classes" && TZ=UTC touch -t 202601010000 $(find . -type f) && jar --create --no-manifest --date=2026-01-01T00:00:00Z --file "$dir/$artifact-$version.jar" .)
  if [ "$sources" = yes ]; then
    (cd "$HERE/src/$artifact-$version" && jar --create --no-manifest --date=2026-01-01T00:00:00Z --file "$dir/$artifact-$version-sources.jar" .)
  fi
  cp "$HERE/poms/$artifact-$version.pom" "$dir/"
  if [ "$repo" = remote ]; then
    for f in "$dir"/*.jar "$dir"/*.pom; do sha1sum "$f" | cut -d' ' -f1 | tr -d '\n' > "$f.sha1"; done
  fi
}
pom_only() {
  local repo="$1" artifact="$2" version="$3" dir="$OUT/$1/com/acme/$2/$3"
  mkdir -p "$dir" && cp "$HERE/poms/$artifact-$version.pom" "$dir/"
}
install m2 common-api 1.0.0 "" no
install m2 orders-api 1.0.0 "-parameters" yes
install m2 orders-api 2.0.0 "" no
pom_only m2 acme-parent 1.0.0
pom_only m2 acme-bom 1.0.0
install remote orders-client 1.0.0 "" no
install remote tampered 1.0.0 "" no
# Une empreinte qui ne correspond pas au jar : le téléchargement doit être refusé.
printf '0000000000000000000000000000000000000000' > "$OUT/remote/com/acme/tampered/1.0.0/tampered-1.0.0.jar.sha1"
echo "dépôts de test reconstruits : $OUT/m2, $OUT/remote"
