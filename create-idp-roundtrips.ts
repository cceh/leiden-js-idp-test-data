import { promises as fs } from "fs";
import { dirname, join } from "path";
import { JSDOM } from "jsdom";

const configs = {
    edition: {
        sourcePath: "idp.data/DDB_EpiDoc_XML",
        targetPath: "roundtrips/DDB_EpiDoc_XML",
        selector: 'div[type="edition"]',
        type: "edition",
        conversion: "epidoc"
    },
    translation: {
        sourcePath: "idp.data/HGV_trans_EpiDoc",
        targetPath: "roundtrips/HGV_trans_EpiDoc",
        selector: "body",
        type: "translation",
        conversion: "translation_epidoc"
    }
};

async function getXmlFiles(dir: string): Promise<string[]> {
    const xmlPaths: string[] = [];

    async function traverse(currentDir: string) {
        const entries = await fs.readdir(currentDir, { withFileTypes: true });

        for (const entry of entries) {
            const path = join(currentDir, entry.name);

            if (entry.isDirectory()) {
                await traverse(path);
            } else if (entry.name.endsWith(".xml")) {
                xmlPaths.push(path);
            }
        }
    }

    await traverse(dir);
    return xmlPaths;
}

async function xsugarConvert(input: string, direction: "xml2nonxml" | "nonxml2xml", conversion: string): Promise<string> {
    const encodedInput = encodeURIComponent(input);
    const postData = `content=${encodedInput}&type=${conversion}&direction=${direction}`;
    const response = await fetch("http://localhost:9999", {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body: postData
    });

    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}\n`);
    }

    const responseData = await response.json();
    if (responseData.exception) {
        throw new Error(`XSugar exception: ${responseData.exception.cause}`);
    }

    return responseData.content;
}

async function processXmlFile(
    filePath: string,
    config: typeof configs["edition"] | typeof configs["translation"],
    currentIndex: number,
    totalFiles: number
): Promise<void> {
    const txtFilePath = filePath
        .replace(config.sourcePath, config.targetPath)
        .replace(".xml", ".txt");
    const roundtripFilePath = filePath
        .replace(config.sourcePath, config.targetPath)
        .replace(".xml", ".roundtrip.xml");

    await fs.mkdir(dirname(roundtripFilePath), { recursive: true });
    await fs.mkdir(dirname(txtFilePath), { recursive: true });


    // Check if output file already exists
    try {
        await fs.access(txtFilePath);
        console.log(`[${currentIndex}/${totalFiles}] ${txtFilePath} already exists, skipping creation.`);
        return;
    } catch {
        // File doesn't exist, continue processing
    }

    try {
        // Read and process XML
        const xmlContent = await fs.readFile(filePath, "utf-8");
        const dom = new JSDOM(xmlContent, { contentType: "text/xml" });
        const element = dom.window.document.querySelector(config.selector);

        if (!element) {
            console.log(`[${currentIndex}/${totalFiles}] No ${config.type} ${config.selector} found in ${filePath}`);
            return;
        }

        // Prepare and encode XML
        const processedXml = element.outerHTML.replace(" xmlns=\"http://www.tei-c.org/ns/1.0\"", "");

        // STEP 1: Convert to leiden
        const xsugarLeiden = await xsugarConvert(processedXml, "xml2nonxml", config.conversion);

        // STEP 2: Roundtrip to XML
        const xsugarXml = await xsugarConvert(xsugarLeiden, "nonxml2xml", config.conversion);
        await fs.writeFile(roundtripFilePath, xsugarXml);
        console.log(`[${currentIndex}/${totalFiles}] Created ${roundtripFilePath}`);

        // STEP 3: Roundtrip-XML to Roundtrip-Leiden
        const roundtripLeiden = await xsugarConvert(xsugarXml, "xml2nonxml", config.conversion);
        await fs.writeFile(txtFilePath, roundtripLeiden);
        console.log(`[${currentIndex}/${totalFiles}] Created ${txtFilePath}`);

    } catch (error) {
        console.error(`[${currentIndex}/${totalFiles}] Error processing ${txtFilePath}:`, error.stack, error.message);
        await fs.writeFile(`${txtFilePath}.fail`, error.message);
    }
}


async function processFiles(configType: keyof typeof configs) {
    const config = configs[configType];
    await fs.mkdir(config.targetPath, { recursive: true });

    try {
        const xmlFiles = await getXmlFiles(config.sourcePath);
        const totalFiles = xmlFiles.length;

        for (let i = 0; i < xmlFiles.length; i++) {
            await processXmlFile(xmlFiles[i], config, i + 1, totalFiles);
        }

        console.log(`Processing complete for ${configType}`);
    } catch (error) {
        console.error("Error:", error.message);
        process.exit(1);
    }
}

// Get the type from command line argument
const type = process.argv[2] as keyof typeof configs;

if (!type || !configs[type]) {
    console.error("Provide a valid type of data to prepare: edition or translation");
    console.error("Usage: tsx create-idp-roundtrips.ts <type>");
    process.exit(1);
}

await processFiles(type);
