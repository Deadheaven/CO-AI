FROM python:3.12-slim
WORKDIR /app
COPY coai_worker /app/coai_worker
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
CMD ["python", "-m", "coai_worker.main"]
