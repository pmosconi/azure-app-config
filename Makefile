.PHONY: help install-ts install-py test-ts test-integration-ts test-py lint-ts lint-py typecheck-ts typecheck-py format-py build-ts build-py publish-ts publish-py publish-py-test pack-ts clean venv-py install test lint

help:
	@echo "Available commands:"
	@echo "  make install-ts         - Install TypeScript dependencies"
	@echo "  make install-py         - Install Python dependencies"
	@echo "  make install            - Install all dependencies"
	@echo "  make test-ts            - Run TypeScript unit tests"
	@echo "  make test-integration-ts - Run TypeScript tests against the real provider (no Azure needed)"
	@echo "  make test-py            - Run Python unit tests"
	@echo "  make test               - Run all tests"
	@echo "  make lint-ts            - Lint TypeScript code"
	@echo "  make lint-py            - Lint Python code"
	@echo "  make typecheck-ts       - Type-check TypeScript code"
	@echo "  make typecheck-py       - Type-check Python code (mypy strict)"
	@echo "  make format-py          - Format Python code"
	@echo "  make build-ts           - Build TypeScript package"
	@echo "  make build-py           - Build Python package"
	@echo "  make pack-ts            - npm pack the TypeScript package (inspect the tarball before publishing)"
	@echo "  make publish-ts         - Publish TypeScript to npm"
	@echo "  make publish-py         - Publish Python to PyPI"
	@echo "  make publish-py-test    - Publish Python to Test PyPI"
	@echo "  make clean              - Clean build artifacts"
	@echo "  make venv-py            - Show Python virtual environment location"

# TypeScript commands
install-ts:
	cd Typescript && npm install

test-ts:
	cd Typescript && npm test

# Drives the real @azure/app-configuration-provider against a reserved .invalid endpoint to check
# the one thing a mocked load() cannot: that clientOptions is still honoured. No Azure, no
# credentials, no egress — but the provider pads a startup failure to five seconds, so it is slow.
test-integration-ts:
	cd Typescript && npm run test:integration

lint-ts:
	cd Typescript && npm run lint

typecheck-ts:
	cd Typescript && npm run typecheck

build-ts:
	cd Typescript && npm run build

pack-ts: build-ts
	cd Typescript && npm pack

publish-ts:
	npm login
	cd Typescript && npm publish

# Python commands — the half is not written yet; the targets are here so the
# shape matches and nothing has to be invented when it is.
install-py:
	@echo "Setting up Python environment with uv..."
	cd Python && uv sync --all-extras --all-groups
	@echo "Virtual environment created at Python/.venv/"

test-py:
	cd Python && uv run pytest -m unit

lint-py:
	cd Python && uv run ruff check src tests
	cd Python && uv run ruff format --check src tests

typecheck-py:
	cd Python && uv run mypy src

format-py:
	cd Python && uv run ruff format src tests

build-py:
	cd Python && rm -rf dist && uv build

publish-py: build-py
	cd Python && uv run twine upload dist/*

publish-py-test: build-py
	cd Python && uv run twine upload --repository testpypi dist/*

# Utility commands
venv-py:
	@echo "Virtual environment location:"
	@cd Python && uv run python -c "import sys; print(sys.prefix)"

# Combined commands
install: install-ts install-py

test: test-ts test-py

lint: lint-ts lint-py

clean:
	rm -rf Typescript/dist Typescript/coverage Typescript/.nyc_output Typescript/*.tgz
	rm -rf Python/dist Python/.pytest_cache Python/src/*.egg-info
	find . -type d -name __pycache__ -exec rm -rf {} +
	find . -type d -name .ruff_cache -exec rm -rf {} +
	find . -type f -name "*.pyc" -delete
