FROM node:20-slim

# Install Python, pip, ffmpeg
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/* && \
    ln -sf /usr/bin/python3 /usr/bin/python

# Install yt-dlp
RUN pip3 install yt-dlp --break-system-packages

# Set working directory
WORKDIR /app

# Install Node dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy app files
COPY server.js ./
COPY public ./public

EXPOSE 3000

CMD ["node", "server.js"]
