FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ripgrep build-essential python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Install common trading and analysis Python libraries
RUN pip3 install --break-system-packages --no-cache-dir \
      pandas \
      numpy \
      requests \
      ccxt \
      dhanhq \
      websocket-client

WORKDIR /workspace
