FROM rust:1-alpine

RUN apk add --no-cache musl-dev

RUN addgroup -S -g 10001 runner \
 && adduser -S -D -u 10001 -G runner -h /home/runner runner \
 && mkdir /workspace && chown runner:runner /workspace

COPY --chmod=755 run /usr/local/bin/run

USER runner
WORKDIR /workspace
LABEL codesync.runner="rust"
CMD ["sleep", "infinity"]
