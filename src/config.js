import "dotenv/config";

export const config = {
  port: Number(process.env.PORT || 5000),
  pythonServiceUrl:
    process.env.PYTHON_SERVICE_URL || "http://localhost:8000",
  aisCsvPath:
    process.env.AIS_CSV_PATH || "./data/ais.csv",
  pythonTimeoutMs:
    Number(process.env.PYTHON_TIMEOUT_MS || 30000)
};