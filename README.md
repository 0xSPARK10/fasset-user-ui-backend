# Fasset user ui backend
## Prerequisite
1. Running a synced version of FAsset indexer on the network you will run the app on. Indexer docs are available [here](https://github.com/flare-labs-ltd/fasset-indexer).
2. Api keys for verifier, DAL api and rpcs.
3. Specs:
AMD64 machine.
Docker version 25.0.4 or higher.
Docker Compose version v2.24.7 or higher
Tested on Ubuntu 22.04.4 LTS.

## Running with DOCKER
1. Copy `.env_template` into `.env` and fill the values.
2. Build with `docker compose --env-file .env build`.
3. Run in detached mode with `docker compose --env-file .env up -d`.


## Running without docker
First run `git submodule init` then `git submodule update`.
OR
`git submodule update --init --recursive`.

After cloning repository initialize fasset-bots submodule with `git submodule init` and `git submodule update`.
Copy `.env.template` to `.env` and fill the values.

Create `secrets.json` as written in configurations.

Install `yarn`, then `yarn build` and run in development `yarn start:dev` or `yarn run start` in production.

Server will be running on port `3001`. Swagger docs are available on `localhost:3001/api-doc`.

For running the app in Docker, an example Dockerfile and docker-compose.yml is available in `docker-example` directory.

## Logger

Use `logger.info()`, `logger.warn()` or `logger.error()` to record log. Logs are stored in folder _backend_log/_


## Configurations

- Make sure you have `fasset-bots` repository in the same directory as this project as it uses symbolic link to access it. The `fasset-bots` repository also needs to be initialized and built with `yarn` and `yarn build`.

- Create _.env_ `cp .env_template .env` and fill with appropriate values.

- Create _secrets.json_ in root directory and fill with values, for testnet:
```
{
    "apiKey": {
        "indexer": [
            ""
        ],
        "native_rpc": ""
    },
    "user": {
        "native": {
            "address": "",
            "private_key": ""
        },
        "testXRP": {
            "address": "",
            "private_key": ""
        },
        "testBTC": {
            "address": "",
            "private_key": ""
        },
        "testDOGE": {
            "address": "",
            "private_key": ""
        }
    },
    "wallet": {
        "encryption_password": ""
    }
}
```
- Create _secrets.json_ in root directory and fill with values, for mainnet:
```
{
    "apiKey": {
        "indexer": [
            "key1",
            "key2"
        ],
        "data_access_layer": [
            "key1"
        ],
        "xrp_rpc": [
            "key1"
        ],
        "native_rpc": ""
    },
    "user": {
        "native": {
            "address": "",
            "private_key": ""
        },
        "XRP": {
            "address": "",
            "private_key": ""
        }
    },
    "wallet": {
        "encryption_password": ""
    }
}
```
  - Indexer apiKey or keys is the api key for underlying chain indexer/verifier.
  - Data access layer api key is for DAL api.
  - Xrp rpc api key is for ripple rpc.
  - Native address is coston/sgb/flare address, this address should be funded with at least 1000 cflr/sgb/flr.
  - TestXRP for testnet or XRP should be underlying asset addresses that do not need to be funded. The values need to be filled.
  - Wallet encryption password should just be some password at least 16 characters long.
  - `Secrets.json` permissions should be set with `chmod 600 secrets.json`. 
