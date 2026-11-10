from flask import Flask
from flask_cors import CORS
from gunicorn import app
from .config import Config
from .routes import register_routes
from .logging_config import configure_logging
from .storage import init_db
from .history_api import history_bp



def create_app():
    app = Flask(__name__)

    CORS(app)

    configure_logging(Config.LOG_LEVEL)
    init_db()
    register_routes(app)
    app.register_blueprint(history_bp)
    
    return app