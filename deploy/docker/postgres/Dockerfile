# Postgres with pgvector, for semantic search (#54; deploy/README.md, "Semantic search").
#
# The same image as compose.yaml's `postgres` service (the same version, pinned by the same
# digest) with only the pgvector extension added, compiled from its source release (pinned by
# version and SHA-256). So it is a drop-in on an existing data volume of that service: the
# server, its libraries and its locale are byte for byte those that wrote the volume.
#
#   docker compose -f compose.yaml -f compose.vector.yaml up -d --build
#
# Only needed with an embedder configured (CCMS_EMBEDDER_URL): without one, search is full
# text plus trigram, which the stock image serves.
ARG POSTGRES_IMAGE=postgres:18.7-alpine@sha256:ff64c9e3bdf8e2120107d3559de8db314e8305f7e38c5105903c6295876738ff

FROM ${POSTGRES_IMAGE} AS build
ARG PGVECTOR_VERSION=0.8.7
ARG PGVECTOR_SHA256=cac0b10c360f05b2d521200105ba3697e773d4cd3731f5a915a7e37ebe0bea85
RUN apk add --no-cache build-base curl
WORKDIR /src
RUN curl -fsSL -o pgvector.tar.gz "https://github.com/pgvector/pgvector/archive/refs/tags/v${PGVECTOR_VERSION}.tar.gz" \
  && echo "${PGVECTOR_SHA256}  pgvector.tar.gz" | sha256sum -c - \
  && tar -xzf pgvector.tar.gz --strip-components=1 \
  # No LLVM bitcode (JIT inlining): it needs the exact clang the server was built with, and
  # gains nothing measurable for vector distances. Portable code (no -march=native), so the
  # image runs on any CPU of its architecture.
  && make with_llvm=no OPTFLAGS="" \
  && make with_llvm=no DESTDIR=/out install

FROM ${POSTGRES_IMAGE}
COPY --from=build /out/usr/local/ /usr/local/
