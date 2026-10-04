FROM mcr.microsoft.com/dotnet/sdk:10.0-alpine

# Containers run with no network, so the SDK must never try to phone home, and
# MSBuild/Roslyn build servers are disabled because a container serves one run.
# MSBuild reads environment variables as properties, hence UseSharedCompilation.
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_NOLOGO=1 \
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 \
    DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE=1 \
    DOTNET_GENERATE_ASPNET_CERTIFICATE=false \
    DOTNET_CLI_USE_MSBUILD_SERVER=0 \
    MSBUILDDISABLENODEREUSE=1 \
    UseSharedCompilation=false \
    DOTNET_CLI_HOME=/home/runner \
    NUGET_PACKAGES=/home/runner/.nuget/packages \
    TMPDIR=/home/runner/tmp

RUN addgroup -S -g 10001 runner \
 && adduser -S -D -u 10001 -G runner -h /home/runner runner \
 && mkdir -p /workspace /home/runner/tmp \
 && chown runner:runner /workspace /home/runner/tmp

COPY --chmod=755 run /usr/local/bin/run

USER runner
WORKDIR /workspace

# Build a file-based app at the exact path used at run time. This performs the
# first-run setup and restore now, while there is network, and leaves the build
# cache in place so a run only recompiles the user's file.
RUN printf 'System.Console.WriteLine("warm");\n' > /workspace/main.cs \
 && dotnet run /workspace/main.cs \
 && rm /workspace/main.cs

LABEL codesync.runner="csharp"
CMD ["sleep", "infinity"]
