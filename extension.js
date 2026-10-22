const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');

function diagnostic(document, diagnostics, line, message) {
    const text = document.lineAt(line).text;
    diagnostics.push(new vscode.Diagnostic(
        new vscode.Range(line, 0, line, Math.max(text.length, 1)),
        message,
        vscode.DiagnosticSeverity.Error
    ));
}


// Validate the current object-oriented PXL syntax. This intentionally stays
// lightweight: the runtime remains the authoritative parser, while the
// extension catches common structural mistakes without rejecting valid
// expressions that may be added to the language.
function validateCurrent(document) {
    const diagnostics = [];
    let braceDepth = 0;
    let hasWindow = false;
    let hasRun = false;

    const declaration = /^(?:window|label|par|button|textbox|textarea|rect|circle|triangle)\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*(?:window|label|par|button|textbox|textarea|rect|circle|triangle)\s*\{$/;
    const triggerDeclaration = /^trigger\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*trigger\s*\(/;
    const variableDeclaration = /^(?:int|short|long|float|double|bool|char|String)\s+[A-Za-z_][A-Za-z0-9_]*\s*=/;
    const control = /^(?:if|while)\s*\(.*\)\s*\{$|^for\s*\(.*\)\s*\{$|^else(?:\s+if\s*\(.*\))?\s*\{$/;
    const field = /^(text|placeholder|title|iconPath|width|height|x|y|font|fontSize|angle|radius|p1|p2|p3|background)\s*:/;

    for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
        const original = document.lineAt(lineNumber).text;
        const trimmed = original.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        const line = trimmed.replace(/[;,]\s*$/, '').trim();
        const hasSemicolon = /;\s*$/.test(trimmed);

        if (declaration.test(line)) {
            hasWindow ||= line.startsWith('window ');
        } else if (triggerDeclaration.test(line) || control.test(line)) {
            // Structural headers are complete without semicolons.
        } else if (field.test(line)) {
            if (braceDepth === 0) {
                diagnostic(document, diagnostics, lineNumber, 'Properties must be inside an object declaration.');
            }
        } else if (variableDeclaration.test(line)) {
            if (!hasSemicolon) diagnostic(document, diagnostics, lineNumber, "Expected ';' at the end of the declaration.");
        } else if (/^[A-Za-z_][A-Za-z0-9_]*\.(add|remove)\s*\(.*\)$/.test(line)) {
            if (!hasSemicolon) diagnostic(document, diagnostics, lineNumber, "Expected ';' at the end of the statement.");
        } else if (/^[A-Za-z_][A-Za-z0-9_]*\.run\s*\(\)$/.test(line)) {
            hasRun = true;
            if (!hasSemicolon) diagnostic(document, diagnostics, lineNumber, "Expected ';' at the end of the statement.");
        } else if (/^[A-Za-z_][A-Za-z0-9_]*\.update\s*\(\)$/.test(line)) {
            if (!hasSemicolon) diagnostic(document, diagnostics, lineNumber, "Expected ';' at the end of the statement.");
        } else if (/^(?:[A-Za-z_][A-Za-z0-9_]*\.)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line) ||
                   /^(?:[A-Za-z_][A-Za-z0-9_]*\.)?[A-Za-z_][A-Za-z0-9_]*\s*(?:\+\+|--)$/.test(line) ||
                   /^(?:print|println)\s*\(.*\)$/.test(line) ||
                   /^(?:switch_view|add_view)\s*\(.*\)$/.test(line)) {
            if (!hasSemicolon) diagnostic(document, diagnostics, lineNumber, "Expected ';' at the end of the statement.");
        } else if (line.includes('{') && line.includes('}')) {
            // Declarations, onclick blocks, and trigger bodies may be written
            // on one line in valid PXL programs.
        } else if (line !== '}' && !line.endsWith('{')) {
            diagnostic(document, diagnostics, lineNumber, 'Unrecognized PXL statement.');
        }

        const withoutStrings = original.replace(/"(?:\\.|[^"\\])*"/g, '""');
        braceDepth += (withoutStrings.match(/{/g) || []).length;
        braceDepth -= (withoutStrings.match(/}/g) || []).length;
        if (braceDepth < 0) {
            diagnostic(document, diagnostics, lineNumber, 'Unexpected closing brace.');
            braceDepth = 0;
        }
    }

    if (!hasWindow) diagnostic(document, diagnostics, 0, 'A window declaration is required.');
    if (hasWindow && !hasRun) diagnostic(document, diagnostics, 0, 'Select a window with windowName.run();');
    if (braceDepth > 0) diagnostic(document, diagnostics, Math.max(document.lineCount - 1, 0), 'Missing closing brace.');
    return diagnostics;
}

function parsePxldocFile(source, fileName) {
    const entries = [];
    // A record separator must be followed by an id header. This keeps normal
    // Markdown horizontal rules inside the documentation body intact.
    const recordPattern = /^---\r?\n(?=id:\s*)([\s\S]*?)\r?\n---\r?\n([\s\S]*?)(?=^---\r?\n(?=id:\s*)|(?![\s\S]))/gm;
    let match;

    while ((match = recordPattern.exec(source)) !== null) {
        const metadata = {};
        for (const line of match[1].split(/\r?\n/)) {
            const separator = line.indexOf(':');
            if (separator === -1) {
                continue;
            }

            const key = line.slice(0, separator).trim();
            const value = line.slice(separator + 1).trim();
            if (key) {
                metadata[key] = value;
            }
        }

        if (!metadata.id || !metadata.name) {
            throw new Error(`${fileName}: every entry needs id and name metadata.`);
        }

        entries.push({
            id: metadata.id,
            name: metadata.name,
            kind: metadata.kind || 'keyword',
            docs: match[2].trim()
        });
    }

    if (entries.length === 0) {
        throw new Error(`${fileName}: no .pxldoc entries found.`);
    }

    return entries;
}

function loadDocumentation(context) {
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const packagedDirectory = path.join(context.extensionPath, 'pxldocs');
    const directories = [
        // Load the packaged copy first. Workspace documentation is the
        // authoritative override during development.
        packagedDirectory,
        workspace && path.join(workspace, 'pxldocs'),
        workspace && path.join(workspace, 'pixelate', 'pxldocs'),
    ].filter(Boolean);
    const documentation = new Map();

    const configuredPath = vscode.workspace
        .getConfiguration('pixelate')
        .get('executablePath');
    const executable = configuredPath || 'pixelate.exe';
    const embedded = spawnSync(executable, ['--docs'], {
        cwd: workspace || context.extensionPath,
        encoding: 'utf8',
        timeout: 2000,
        windowsHide: true
    });

    if (!embedded.error && embedded.status === 0 && embedded.stdout) {
        try {
            for (const entry of parsePxldocFile(embedded.stdout, `${executable} --docs`)) {
                documentation.set(entry.id, entry);
            }
        } catch (error) {
            console.warn(`Could not load embedded Pixelate documentation: ${error.message}`);
        }
    }

    for (const directory of directories) {
        if (!fs.existsSync(directory)) {
            continue;
        }

        for (const fileName of fs.readdirSync(directory).filter(name => name.endsWith('.pxldoc'))) {
            const filePath = path.join(directory, fileName);
            try {
                for (const entry of parsePxldocFile(fs.readFileSync(filePath, 'utf8'), fileName)) {
                    // Embedded runtime docs take precedence over the packaged
                    // fallback, while workspace docs remain the final override.
                    if (directory === packagedDirectory && documentation.has(entry.id)) {
                        continue;
                    }
                    if (documentation.has(entry.id)) {
                        console.warn(`Duplicate Pixelate documentation id: ${entry.id}. Using ${filePath}.`);
                    }
                    documentation.set(entry.id, entry);
                }
            } catch (error) {
                console.warn(`Could not load Pixelate documentation from ${filePath}: ${error.message}`);
            }
        }
    }

    return documentation;
}

function findWidgetDocumentation(document, word) {
    const escapedWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
        `^\\s*(label|par|button|textbox|textarea|rect|circle|triangle)\\s+${escapedWord}\\s*=\\s*\\1\\s*\\{`
    );

    const lines = document.getText().split(/\r?\n/);
    const declarationIndex = lines.findIndex(line => pattern.test(line));

    if (declarationIndex === -1) {
        return undefined;
    }

    const declaration = lines[declarationIndex].match(pattern);
    const type = declaration[1] === 'button'
        ? 'Button'
        : declaration[1] === 'par'
            ? 'Paragraph'
        : declaration[1] === 'textarea'
            ? 'Textarea'
            : declaration[1] === 'textbox'
                ? 'Textbox'
                : declaration[1] === 'rect'
                    ? 'Rectangle'
                    : declaration[1] === 'circle'
                        ? 'Circle'
                        : declaration[1] === 'triangle'
                            ? 'Triangle'
                            : 'Label';
    const details = [`**${word}**`, `\n${type} widget.`];
    let braceDepth = 1;

    for (let index = declarationIndex + 1; index < lines.length; index++) {
        const line = lines[index];
        const property = line.trim().match(/^(text|x|y|width|height|angle|radius|p1|p2|p3)\s*:\s*(.+)$/);

        if (braceDepth > 0 && property) {
            details.push(`\n- **${property[1]}:** ${property[2]}`);
        }

        const withoutStrings = line.replace(/"(?:\\.|[^"\\])*"/g, '');
        braceDepth += (withoutStrings.match(/{/g) || []).length;
        braceDepth -= (withoutStrings.match(/}/g) || []).length;

        if (braceDepth <= 0) {
            break;
        }
    }

    return details.join('');
}

function provideHover(document, position, documentation) {
    const range = document.getWordRangeAtPosition(
        position,
        /[A-Za-z_][A-Za-z0-9_]*/
    );

    if (!range) {
        return undefined;
    }

    const word = document.getText(range);
    const entry = documentation.get(word);
    const markdown = entry
        ? `## ${entry.name}\n\n${entry.docs}`
        : findWidgetDocumentation(document, word);

    if (!markdown) {
        return undefined;
    }

    return new vscode.Hover(
        new vscode.MarkdownString(markdown),
        range
    );
}

function expandWorkspaceVariable(value) {
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    if (workspace) {
        return value.replace(/\$\{workspaceFolder\}/g, workspace);
    }

    return value;
}

async function runCurrentFile(context, output) {
    const editor = vscode.window.activeTextEditor;

    if (!editor || editor.document.languageId !== 'pxl') {
        vscode.window.showErrorMessage('Open a .pxl file before running it.');
        return;
    }

    await editor.document.save();

    const configuredPath = vscode.workspace
        .getConfiguration('pixelate')
        .get('executablePath');

    // Use the configured command directly. The default is pixelate.exe,
    // which lets the operating system resolve the executable through PATH.
    const executable = configuredPath || 'pixelate.exe';

    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const cwd = workspace || path.dirname(editor.document.fileName);

    output.clear();
    output.appendLine(`Running: ${executable} ${editor.document.fileName}`);
    output.show(true);

    const child = spawn(executable, [editor.document.fileName], {
        cwd,
        windowsHide: false
    });

    child.stdout.on('data', data => output.append(data.toString()));
    child.stderr.on('data', data => output.append(data.toString()));

    child.on('error', error => {
        output.appendLine(`\nFailed to start Pixelate: ${error.message}`);
        vscode.window.showErrorMessage(
            `Could not start Pixelate runtime: ${error.message}`
        );
    });

    child.on('close', code => {
        output.appendLine(`\nPixelate exited with code ${code}.`);
    });
}

function activate(context) {
    const diagnostics = vscode.languages.createDiagnosticCollection('pxl');
    const output = vscode.window.createOutputChannel('Pixelate');
    let documentation = loadDocumentation(context);
    const hoverProvider = vscode.languages.registerHoverProvider(
        'pxl',
        { provideHover: (document, position) => provideHover(document, position, documentation) }
    );

    const reloadDocumentation = () => {
        documentation = loadDocumentation(context);
    };

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
        const documentationWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(workspaceFolder, '**/pxldocs/*.pxldoc')
        );

        context.subscriptions.push(
            documentationWatcher,
            documentationWatcher.onDidCreate(reloadDocumentation),
            documentationWatcher.onDidChange(reloadDocumentation),
            documentationWatcher.onDidDelete(reloadDocumentation)
        );
    }

    function refresh(document) {
        if (document.languageId === 'pxl') {
            diagnostics.set(document.uri, validateCurrent(document));
        }
    }

    context.subscriptions.push(diagnostics);
    context.subscriptions.push(output);
    context.subscriptions.push(hoverProvider);
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'pixelate.runCurrentFile',
            () => runCurrentFile(context, output)
        )
    );
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(refresh),
        vscode.workspace.onDidChangeTextDocument(event => refresh(event.document)),
        vscode.workspace.onDidCloseTextDocument(document => diagnostics.delete(document.uri))
    );

    vscode.workspace.textDocuments.forEach(refresh);
}

function deactivate() {
}

module.exports = {
    activate,
    deactivate
};
