FROM alpine:3.20 AS builder
RUN apk add --no-cache build-base git
RUN git clone https://github.com/pcherenkov/udpxy.git /src && \
    cd /src/chipmunk && \
    make && \
    cp udpxy /usr/local/bin/

FROM alpine:3.20
COPY --from=builder /usr/local/bin/udpxy /usr/local/bin/udpxy
EXPOSE 4022
CMD ["udpxy", "-T", "-p", "4022", "-B", "10485760", "-c", "20"]
