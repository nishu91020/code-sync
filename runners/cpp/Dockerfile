FROM alpine:3.20

RUN apk add --no-cache g++

# Precompile <bits/stdc++.h> with exactly the flags `run` uses. GCC picks up
# the .gch next to the header automatically, which takes several seconds off
# every compile that includes it.
RUN header="$(find /usr/include/c++ -path '*/bits/stdc++.h' | head -n 1)" \
 && g++ -std=c++20 -O2 -x c++-header "$header" -o "$header.gch"

RUN addgroup -S -g 10001 runner \
 && adduser -S -D -u 10001 -G runner -h /home/runner runner \
 && mkdir /workspace && chown runner:runner /workspace

COPY --chmod=755 run /usr/local/bin/run

USER runner
WORKDIR /workspace
LABEL codesync.runner="cpp"
CMD ["sleep", "infinity"]
