import { promises as fs } from "fs";
import { dirname, join } from "path";
import { JSDOM } from "jsdom";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

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

interface StateFile {
    lastProcessedCommit: string;
    timestamp: string;
}

const getStateFile = (configType: string) => `.idp-roundtrips-state-${configType}.json`;

async function getCurrentSubmoduleCommit(): Promise<string> {
    try {
        const { stdout } = await execAsync("cd idp.data && git rev-parse HEAD");
        return stdout.trim();
    } catch (error) {
        throw new Error(`Failed to get current submodule commit: ${error.message}`);
    }
}

async function getChangedFilesSince(lastCommit: string | null, config: typeof configs["edition"] | typeof configs["translation"]): Promise<{files: string[], stats: {added: number, modified: number, deleted: number}}> {
    const relevantPath = config.sourcePath.replace("idp.data/", "");
    
    if (!lastCommit) {
        // First run - get all files via find
        const { stdout } = await execAsync(`cd idp.data && find ${relevantPath} -name "*.xml" -type f`);
        const files = stdout
            .split('\n')
            .filter(file => file.trim())
            .map(file => join("idp.data", file));
        return { 
            files, 
            stats: { added: files.length, modified: 0, deleted: 0 }
        };
    } else {
        // Get files changed since last commit with status
        console.log(`Fetching latest processed commit ${lastCommit}...`);
        const fetchResult = await execAsync(`cd idp.data && git fetch origin --depth 1 ${lastCommit}`);
        console.log(fetchResult.stdout, fetchResult.stderr);
        console.log("Getting changes...");
        const [addedResult, modifiedResult, deletedResult] = await Promise.all([
            execAsync(`cd idp.data && git diff --name-only --diff-filter=A ${lastCommit}..HEAD`),
            execAsync(`cd idp.data && git diff --name-only --diff-filter=M ${lastCommit}..HEAD`),
            execAsync(`cd idp.data && git diff --name-only --diff-filter=D ${lastCommit}..HEAD`)
        ]);

        const filterRelevant = (stdout: string) => 
            stdout.split('\n')
                .filter(file => file.trim())
                .filter(file => file.startsWith(relevantPath))
                .filter(file => file.endsWith('.xml'))
                .map(file => join("idp.data", file));

        const added = filterRelevant(addedResult.stdout);
        const modified = filterRelevant(modifiedResult.stdout);
        const deleted = filterRelevant(deletedResult.stdout);
        
        const allFiles = [...added, ...modified];
        
        return { 
            files: allFiles, 
            stats: { 
                added: added.length, 
                modified: modified.length, 
                deleted: deleted.length 
            }
        };
    }
}

async function getLastProcessedCommit(configType: string): Promise<string | null> {
    try {
        const stateFile = getStateFile(configType);
        const stateContent = await fs.readFile(stateFile, "utf-8");
        const state: StateFile = JSON.parse(stateContent);
        return state.lastProcessedCommit;
    } catch (error) {
        // State file doesn't exist or is invalid - first run
        return null;
    }
}

async function updateProcessedState(configType: string): Promise<void> {
    try {
        const currentCommit = await getCurrentSubmoduleCommit();
        const lastProcessedCommit = await getLastProcessedCommit(configType);
        
        // Only update if the processed commit has actually changed
        if (lastProcessedCommit !== currentCommit) {
            const state: StateFile = {
                lastProcessedCommit: currentCommit,
                timestamp: new Date().toISOString()
            };
            
            const stateFile = getStateFile(configType);
            await fs.writeFile(stateFile, JSON.stringify(state, null, 2));
            console.log(`Updated ${configType} state: processed commit ${currentCommit.substring(0, 8)}`);
        } else {
            console.log(`${configType} state unchanged: already at commit ${currentCommit.substring(0, 8)}`);
        }
    } catch (error) {
        console.warn(`Warning: Failed to update state file: ${error.message}`);
    }
}

async function getMissingOutputFiles(config: typeof configs["edition"] | typeof configs["translation"], retryFailures: boolean = false): Promise<{files: string[], skippedFailures: number}> {
    const allXmlFiles = await getXmlFiles(config.sourcePath);
    const missingOutputs: string[] = [];
    let skippedFailures = 0;
    
    for (const xmlFile of allXmlFiles) {
        const txtFile = xmlFile
            .replace(config.sourcePath, config.targetPath)
            .replace(".xml", ".txt");
        const failFile = `${txtFile}.fail`;
        
        try {
            await fs.access(txtFile);
            // Output exists - skip
        } catch {
            // Output missing - check if we should retry failures
            if (!retryFailures) {
                try {
                    await fs.access(failFile);
                    // .fail file exists and --retry-failures not specified - skip
                    skippedFailures++;
                    continue;
                } catch {
                    // No .fail file - process normally
                }
            }
            
            missingOutputs.push(xmlFile);
        }
    }
    
    return { files: missingOutputs, skippedFailures };
}

async function validateSubmodule(): Promise<void> {
    try {
        await fs.access("idp.data");
        const { stdout } = await execAsync("cd idp.data && git rev-parse --git-dir");
        if (!stdout.trim()) {
            throw new Error("idp.data is not a git repository");
        }
    } catch (error) {
        throw new Error(`Submodule validation failed: ${error.message}. Run 'npm run get-data' to initialize the submodule.`);
    }
}

async function getFilesToProcess(config: typeof configs["edition"] | typeof configs["translation"], configType: string, retryFailures: boolean = false): Promise<string[]> {
    // Validate submodule first
    await validateSubmodule();
    
    const currentCommit = await getCurrentSubmoduleCommit();
    const lastProcessed = await getLastProcessedCommit(configType);
    
    let filesToProcess: string[] = [];
    
    // Get files changed since last processing (or all files if first run)
    if (!lastProcessed || lastProcessed !== currentCommit) {
        console.log(lastProcessed ? 
            `Submodule updated from ${lastProcessed.substring(0, 8)} to ${currentCommit.substring(0, 8)}` :
            "First run - no previous state found"
        );
        
        const { files: changedFiles, stats } = await getChangedFilesSince(lastProcessed, config);
        filesToProcess.push(...changedFiles);
        
        if (changedFiles.length > 0) {
            const parts = [];
            if (stats.added > 0) parts.push(`${stats.added} added`);
            if (stats.modified > 0) parts.push(`${stats.modified} modified`);
            if (stats.deleted > 0) parts.push(`${stats.deleted} deleted`);
            console.log(`Found ${changedFiles.length} changed files via git (${parts.join(', ')})`);
        }
    } else {
        console.log(`Submodule unchanged at commit ${currentCommit.substring(0, 8)}`);
    }
    
    // Always check for missing outputs (handles manual deletion scenario)
    const { files: missingOutputs, skippedFailures } = await getMissingOutputFiles(config, retryFailures);
    filesToProcess.push(...missingOutputs);
    
    if (missingOutputs.length > 0) {
        console.log(`Found ${missingOutputs.length} files with missing outputs${retryFailures ? ' (including failures)' : ''}`);
    }
    
    if (skippedFailures > 0) {
        console.log(`Skipped ${skippedFailures} previously failed files (use --retry-failures to retry)`);
    }
    
    // Remove duplicates and return
    const uniqueFiles = Array.from(new Set(filesToProcess));
    
    if (uniqueFiles.length === 0) {
        console.log("No files need processing - all outputs are up to date");
    }
    
    return uniqueFiles;
}

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

async function restartXSugarContainer(): Promise<void> {
    try {
        console.log("Restarting XSugar container...");
        await execAsync("docker-compose restart xsugar");
        
        // Wait for container to be healthy
        let attempts = 0;
        const maxAttempts = 30;
        while (attempts < maxAttempts) {
            try {
                const response = await fetch("http://localhost:9999", { method: "GET" });
                if (response.ok) {
                    console.log("XSugar container is healthy");
                    return;
                }
            } catch {
                // Continue waiting
            }
            
            attempts++;
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
        }
        
        throw new Error("XSugar container failed to become healthy after restart");
    } catch (error) {
        throw new Error(`Failed to restart XSugar container: ${error.message}`);
    }
}

async function xsugarConvert(input: string, direction: "xml2nonxml" | "nonxml2xml", conversion: string): Promise<string> {
    const encodedInput = encodeURIComponent(input);
    const postData = `content=${encodedInput}&type=${conversion}&direction=${direction}`;
    
    try {
        const response = await fetch("http://localhost:9999", {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded"
            },
            body: postData
        });

        if (response.status === 500) {
            await restartXSugarContainer();
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const responseData = await response.json();
        if (responseData.exception) {
            throw new Error(`XSugar exception: ${responseData.exception.cause}`);
        }

        return responseData.content;
    } catch (error) {
        if (error.message.includes('fetch failed') || error.code === 'ECONNREFUSED') {
            await restartXSugarContainer();
        }
        throw error;
    }
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

    let currentStep = null;

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
        currentStep = "original XML -> Leiden";
        const xsugarLeiden = await xsugarConvert(processedXml, "xml2nonxml", config.conversion);

        // STEP 2: Roundtrip to XML
        currentStep = "Generated Leiden -> XML";
        const xsugarXml = await xsugarConvert(xsugarLeiden, "nonxml2xml", config.conversion);
        await fs.writeFile(roundtripFilePath, xsugarXml);
        console.log(`[${currentIndex}/${totalFiles}] Created ${roundtripFilePath}`);

        // STEP 3: Roundtrip-XML to Roundtrip-Leiden
        currentStep = "Roundtrip XML -> Leiden";
        const roundtripLeiden = await xsugarConvert(xsugarXml, "xml2nonxml", config.conversion);
        await fs.writeFile(txtFilePath, roundtripLeiden);
        console.log(`[${currentIndex}/${totalFiles}] Created ${txtFilePath}`);

        // Clean up any existing .fail file on successful processing
        const failFile = `${txtFilePath}.fail`;
        try {
            await fs.unlink(failFile);
            console.log(`[${currentIndex}/${totalFiles}] Removed old failure file for ${txtFilePath}`);
        } catch {
            // Ignore if .fail file doesn't exist
        }

    } catch (error) {
        console.error(`[${currentIndex}/${totalFiles}] Error processing ${txtFilePath}:`, error.stack, error.message);
        await fs.writeFile(`${txtFilePath}.fail`, `${currentStep}: ${error.message}`);
    }
}


async function processFiles(configType: keyof typeof configs, retryFailures: boolean = false) {
    const config = configs[configType];
    await fs.mkdir(config.targetPath, { recursive: true });

    try {
        const xmlFiles = await getFilesToProcess(config, configType, retryFailures);
        const totalFiles = xmlFiles.length;

        if (totalFiles === 0) {
            console.log(`No files to process for ${configType}`);
        } else {
            console.log(`Processing ${totalFiles} files for ${configType}`);
            
            for (let i = 0; i < xmlFiles.length; i++) {
                await processXmlFile(xmlFiles[i], config, i + 1, totalFiles);
            }
        }

        // Update state file after successful processing (even if no files were processed)
        await updateProcessedState(configType);
        console.log(`Processing complete for ${configType}`);
    } catch (error) {
        console.error("Error:", error.message);
        process.exit(1);
    }
}

// Parse command line arguments
const type = process.argv[2] as keyof typeof configs;
const retryFailures = process.argv.includes('--retry-failures');

if (!type || !configs[type]) {
    console.error("Provide a valid type of data to prepare: edition or translation");
    console.error("Usage: tsx create-idp-roundtrips.ts <type> [--retry-failures]");
    process.exit(1);
}

await processFiles(type, retryFailures);
