FROM node:22-alpine

RUN addgroup -S -g 10001 runner \
 && adduser -S -D -u 10001 -G runner -h /home/runner runner \
 && mkdir /workspace && chown runner:runner /workspace

COPY --chmod=755 run /usr/local/bin/run

USER runner
WORKDIR /workspace
LABEL codesync.runner="javascript"
CMD ["sleep", "infinity"]
