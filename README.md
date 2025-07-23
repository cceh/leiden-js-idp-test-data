# Leiden IDP Test Data for [leiden-js](https://github.com/cceh/leiden-js)

This repository contains edition and translation data from the [Integrating Digital Papyrology project (IDP)](https://github.com/papyri/idp.data) used for testing the [leiden-js](https://github.com/cceh/leiden-js) parsers and transformers. The data has been processed through a recent version of [XSugar with the Leiden grammars](https://github.com/papyri/xsugar) to convert XML to Leiden+/Leiden translation format and back to XML.

This ensures we're working with up-to-date data that matches what the current XSugar grammar would produce, since some files in the IDP dataset don't match the output that the current IDP XSugar processor would generate from the same input. This repository's data is used alongside the IDP test suite in [leiden-js](https://github.com/cceh/leiden-js) to verify compatibility.

The roundtrip data is generated using `create-idp-roundtrips.ts`, which:

1. Reads XML files from source directories (`idp.data/DDB_EpiDoc_XML` or `idp.data/HGV_trans_EpiDoc`)
2. Extracts content matching the configured selector (`div[type="edition"]` or `body`)
3. Uses XSugar (in Docker) to convert XML to Leiden+ or Leiden Translation
4. Converts the Leiden back to XML and saves it in the corresponding `roundtrips` directory

The script uses git-based change detection to only process files that have changed since the last run per default.


## Re-generate the data

Regenerate the test data when:
- The IDP data has been updated
- There's a new version of the IDP XSugar processor

### Initial Setup

First clone with the `--recursive` flag to include the IDP data submodule:

```bash
git clone --recursive https://github.com/cceh/leiden-js-idp-test-data.git
cd leiden-js-idp-test-data
npm install
```

To update the IDP data (if needed):

```bash
git submodule update --init --depth 1 ./idp.data
```

### Generate the roundtrips

Generate all data at once:

```bash
npm run generate
```

This will start XSugar, process edition and translation files, then shut down the service.

### Or step-by-step

Run each step manually:

1. **Start XSugar**:
   ```bash
    docker-compose up -d
   ```

2. **Generate edition roundtrips**:
    ```bash
    tsx create-idp-roundtrips.ts edition
    ```

3. **Generate translation roundtrips**:
   ```bash
   tsx create-idp-roundtrips.ts translation
   ```

### Advanced Usage

- **Retry failed files**: `tsx create-idp-roundtrips.ts <type> --retry-failures`
- **Force full regeneration**: Delete state files and run normally
- The script automatically skips previously failed files unless `--retry-failures` is used

4. **Stop XSugar**:
   ```bash
   docker-compose down
   ```

## Licensing

- IDP data and derived files in `roundtrips`: CC-BY 3.0 (see [roundtrips/LICENSE](./roundtrips/LICENSE))
- Everything else: MIT License (see [LICENSE](./LICENSE))
