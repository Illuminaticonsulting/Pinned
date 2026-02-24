"""Application configuration loaded from environment variables."""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """AI service configuration.

    All values can be overridden via environment variables or a .env file
    located in the service root directory.
    """

    REDIS_URL: str = "redis://localhost:6379"
    DATABASE_URL: str = "postgresql://pinned:pinned_dev@localhost:5432/pinned"
    MODEL_PATH: str = "./models"
    PREDICTION_INTERVAL_SECONDS: int = 30
    REGIME_UPDATE_INTERVAL_SECONDS: int = 30
    FEATURE_WINDOW_SIZE: int = 500
    DELTA_WINDOW_SIZE: int = 1000
    MIN_CONFIDENCE_THRESHOLD: float = 0.6
    LOG_LEVEL: str = "INFO"

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()
