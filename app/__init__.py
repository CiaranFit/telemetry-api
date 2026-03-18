from flask import Flask
from flask_cors import CORS
from .config import Config
from .routes import register_routes
from .logging_config import configure_logging
from .storage import init_db

def create_app():
    app = Flask(__name__)

    CORS(app)

    configure_logging(Config.LOG_LEVEL)
    init_db()
    register_routes(app)

    return app