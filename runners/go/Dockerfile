FROM golang:1.25-alpine

# CGO is off and the toolchain is pinned so no C compiler or toolchain download
# is ever needed. The values must match at warm-up and at run time, because
# they are part of the build-cache key.
ENV CGO_ENABLED=0 \
    GOTOOLCHAIN=local \
    GOPATH=/home/runner/go \
    GOCACHE=/home/runner/.cache/go-build

RUN addgroup -S -g 10001 runner \
 && adduser -S -D -u 10001 -G runner -h /home/runner runner \
 && mkdir /workspace && chown runner:runner /workspace

COPY --chmod=755 run /usr/local/bin/run

USER runner
WORKDIR /workspace

# Pre-compile the standard-library packages people commonly import, so the
# first `go build` in a fresh container only compiles the user's own file.
COPY --chown=runner:runner warm.go /home/runner/warm.go
RUN go build -o /tmp/warm /home/runner/warm.go && rm /tmp/warm /home/runner/warm.go

LABEL codesync.runner="go"
CMD ["sleep", "infinity"]
