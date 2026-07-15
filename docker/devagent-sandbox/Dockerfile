FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ripgrep build-essential \
    && rm -rf /var/lib/apt/lists/*

# Add language toolchains here only as the repos this agent operates
# on actually need them (ruby, python3, etc.) — keep this minimal,
# it's the blast radius for anything a model-issued command runs.

WORKDIR /workspace
