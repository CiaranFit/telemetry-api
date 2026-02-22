from flask import Flask
from .routes import register_routes
from .logging_config import configure_logging
from .storage import init_db

def create_app():
    app = Flask(__name__)

    configure_logging()
    init_db()
    register_routes()

    return app