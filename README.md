# cookiecrumbler

[![License](https://img.shields.io/badge/License-MPL--2.0-blue)](LICENSE)

Cookiecrumbler automatically detects cookie consent notices on Web pages. It's intended to help with both detection of cookie consent notices that we don't currently block, and to identify webcompat reports as being related to cookie consent notice blocking. 

## Deployment status

Cookiecrumbler is currently being developed as a Web app which will help us run crawls and/or integrate with the webcompat reporter backend. It can also be [used as a library](using-as-a-library). In the future, we could even bundle it in the browser.

## Setup

### Local Setup
1. Install [Brave Browser](https://brave.com/linux/).

2. Install dependencies and setup browser profiles:
```bash
npm install
npm run setup -- /path/to/brave
```

Note: If browser profiles need to be updated, remove the `profiles` directory and run the setup again.

### Docker Setup
1. Ensure you have Docker and Docker Compose installed.

2. Run the initial setup:
```bash
cp .env.example .env
docker compose run --rm --entrypoint ./docker_setup.sh brave
```

Note: If browser profiles need to be updated, run the setup command again.

## Running

### Local
Start the server:
```bash
npm run serve
```

You can customize the browser and port:
```bash
npm run serve -- /usr/bin/brave-nightly 8000
```

### Docker
1. Basic setup (without LLM support):
```bash
docker compose up brave
```

2. With LLM support via Ollama:
```bash
docker compose --profile ollama up brave_ollama
```

3. With LLM support via AWS Bedrock:
```bash
aws-vault exec cookiecrumbler-bedrock -- docker compose --profile litellm up
```

> [!NOTE]
> You will need to set up the AWS profile in your environment.

For all setups, visit `localhost:3000` in your browser.

## Using as a library

```js
import { checkPage } from 'cookiecrumbler';

const result = await checkPage({
  url: 'https://example.com',        // URL to visit
  seconds: 4,                        // delay before checking for a notice
  interactive: false,                // show the browser while running?
  executablePath: '/path/to/binary', // what browser to run
  adblockLists: {                    // enable/disable filter lists by component id
    'cdbbhgbmjhfnhnmgeddbliobbofkgdhe': false,
  },
  screenshot: true,                  // return images of detected notices or full page (see Screenshots section)
  markup: true,                      // return markup of detected notices
});
```

## Screenshots

The `screenshot` parameter can be set to `true`, `false`, `always`, `fullPage`, the behavior is summarized in the following table:

| value     | element detected | no element detected |
|-----------|------------------|---------------------|
| true      | 🎯               | ❌                  |
| false     | ❌               | ❌                  |
| always    | 🎯               | 📄                  |
| fullPage  | 📄               | 📄                  |

**Legend**:  
🎯 - Screenshot of detected element  
📄 - Screenshot of full page  
❌ - No screenshot  

## Testing

```
npm run test
```

You can also pass a path to a different browser binary if necessary:

```
npm run test -- /usr/bin/brave-nightly
```

### Generating test cases

There is a set of regression test cases in the `testcases` directory.

Each test case is a single self-contained HTML file.
These files can be generated using a tool like [nodeSavePageWE](https://github.com/markusmobius/nodeSavePageWE).
