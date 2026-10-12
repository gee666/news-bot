FROM unclecode/crawl4ai:0.9.4@sha256:9021b3cb5c6f12570bbcd5395638495e0a06969b3148e377b953d174af2ebc9b
USER root
COPY config.yml /app/config.yml
COPY newsbot_server.py /app/newsbot_server.py
# Retain the official Redis/auth bootstrap and non-root process configuration.
RUN python -c "from pathlib import Path; p=Path('/app/supervisord.conf'); s=p.read_text(); assert 'server:app' in s; p.write_text(s.replace('server:app', 'newsbot_server:app').replace('--timeout 1800', '--timeout 65').replace('--keep-alive 300', '--keep-alive 5'))"
USER appuser
