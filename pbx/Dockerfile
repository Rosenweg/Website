FROM mlan/asterisk:xtra-1.1.13

# Tools fuer das Voicemail-Transcribe-AGI-Script
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-requests \
    curl \
    jq \
    sox \
  && rm -rf /var/lib/apt/lists/*

# Eigene Config drueberkopieren (Image-Defaults werden ueberschrieben)
COPY asterisk-config/ /etc/asterisk/
COPY agi/ /var/lib/asterisk/agi-bin/
RUN chmod +x /var/lib/asterisk/agi-bin/*.py 2>/dev/null || true \
  && chown -R asterisk:asterisk /etc/asterisk /var/lib/asterisk /var/spool/asterisk \
  && mkdir -p /var/spool/asterisk/voicemail/recordings \
  && chown -R asterisk:asterisk /var/spool/asterisk/voicemail

EXPOSE 5060/udp 5060/tcp 5061/tcp 10000-10100/udp
