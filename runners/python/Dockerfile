FROM python:3.12-alpine

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN addgroup -S -g 10001 runner \
 && adduser -S -D -u 10001 -G runner -h /home/runner runner \
 && mkdir /workspace && chown runner:runner /workspace

COPY --chmod=755 run /usr/local/bin/run

USER runner
WORKDIR /workspace
LABEL codesync.runner="python"
CMD ["sleep", "infinity"]
