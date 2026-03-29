FROM alpine:3.20
RUN apk add --no-cache udpxy
EXPOSE 4022
CMD ["udpxy", "-T", "-p", "4022", "-m", "eth0", "-B", "10485760", "-c", "20"]
