FROM python:3.12-slim
RUN pip install --no-cache-dir psycopg2-binary
COPY collector.py /app/collector.py
WORKDIR /app
CMD ["python3", "-u", "collector.py"]
