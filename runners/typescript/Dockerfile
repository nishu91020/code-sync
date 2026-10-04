FROM node:22-alpine

# tsx is baked in so TypeScript runs without anything being fetched at runtime.
RUN npm install -g tsx@4 && npm cache clean --force

RUN addgroup -S -g 10001 runner \
 && adduser -S -D -u 10001 -G runner -h /home/runner runner \
 && mkdir /workspace && chown runner:runner /workspace

COPY --chmod=755 run /usr/local/bin/run

USER runner
WORKDIR /workspace
LABEL codesync.runner="typescript"
CMD ["sleep", "infinity"]
