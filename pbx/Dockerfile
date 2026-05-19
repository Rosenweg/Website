FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Asterisk + Tools fuer Voicemail-Transkription
RUN apt-get update && apt-get install -y --no-install-recommends \
    asterisk \
    ca-certificates \
    curl \
    jq \
    python3 \
    python3-requests \
    sox \
    dumb-init \
  && rm -rf /var/lib/apt/lists/*

# Asterisk Default-Config wegraeumen, eigene Config wird gemounted
RUN rm -rf /etc/asterisk/*.conf /etc/asterisk/extensions.d /etc/asterisk/pjsip.d 2>/dev/null || true \
  && mkdir -p /var/lib/asterisk/sounds/de /var/spool/asterisk/voicemail \
  && chown -R asterisk:asterisk /etc/asterisk /var/lib/asterisk /var/spool/asterisk /var/log/asterisk /var/run/asterisk

COPY asterisk-config/ /etc/asterisk/
COPY agi/ /var/lib/asterisk/agi-bin/
RUN chmod +x /var/lib/asterisk/agi-bin/*.sh /var/lib/asterisk/agi-bin/*.py 2>/dev/null || true

USER asterisk
EXPOSE 5060/udp 5060/tcp 5061/tcp 10000-10100/udp

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["asterisk", "-f", "-vvv"]
