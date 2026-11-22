# Empfänger für das Journal der Stationen (os-stationen, systemd-journal-upload).
# Siehe journal-remote/README.md.
#
# Debians systemd-journal-remote ist ohne GnuTLS gebaut ("Option --trust= is
# not available"): es kann keine Client-Zertifikate prüfen. Deshalb nimmt nginx
# die TLS-Verbindung an und verlangt das Zertifikat der Stations-CA; dahinter
# läuft journal-remote nur auf 127.0.0.1 über HTTP.
FROM debian:trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends systemd-journal-remote systemd nginx-light ca-certificates \
 && rm -rf /var/lib/apt/lists/* /etc/nginx/sites-enabled/default
COPY nginx.conf /etc/nginx/conf.d/journal.conf
COPY start.sh /usr/local/bin/start.sh
RUN chmod 0755 /usr/local/bin/start.sh
EXPOSE 19532
CMD ["/usr/local/bin/start.sh"]
