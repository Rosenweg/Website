# Empfänger für das Journal der Stationen (os-stationen, systemd-journal-upload).
# Siehe journal-remote/README.md.
FROM debian:trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends systemd-journal-remote systemd ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY start.sh /usr/local/bin/start.sh
RUN chmod 0755 /usr/local/bin/start.sh
EXPOSE 19532
CMD ["/usr/local/bin/start.sh"]
