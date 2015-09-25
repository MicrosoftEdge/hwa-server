import cp = require("child_process");
import fs = require("fs");
import net = require("net");
import os = require("os");
import p = require("path");

var admzip = require("adm-zip");
var appxTools = require("appx-tools");
var rimraf = require("rimraf");

var PORT = 6767;
var PROTOCOL_VERSION = 1;

var rootTempPath = p.join(os.tmpdir(), "hwa-server");
var appxManifestZipPath = p.join(rootTempPath, "AppxManifest.zip");
var appxManifestTempPath = p.join(rootTempPath, "AppxManifest");
var appxManifestFilePath = p.join(appxManifestTempPath, "AppxManifest.xml");

var verbose = false;
if (process.argv.indexOf("verbose") >= 0) {
    console.log("Running in server in verbose mode");
    verbose = true;
}
appxTools.verbose = verbose;

function cleanTemp() {
    rimraf.sync(rootTempPath);
    fs.mkdirSync(rootTempPath);
}

appxTools.terminateAppx();
cleanTemp();

function processInitialData(buffer: Buffer) {
    // Raw data format: 'version;command;data'
    // Note: There may be additional semicolons contained in the data portion,
    // but we are only interested in the first two.
    var retVal = {
        version: -1,
        command: "",
        dataLength: 0,
        data: <Buffer>null
    };

    var sepCount = 0;
    var prevSeparator = -1;
    for (var i = 0; i < buffer.length; i++) {
        if (buffer[i] === 59 /* ; */) {
            if (sepCount === 0) {
                retVal.version = +buffer.slice(0, i).toString();
            } else if (sepCount === 1) {
                retVal.command = buffer.slice(prevSeparator + 1, i).toString();
            } else {
                retVal.dataLength = +buffer.slice(prevSeparator + 1, i).toString();
                retVal.data = buffer.slice(i + 1);
                return retVal;
            }
            prevSeparator = i;
            sepCount++;
        }
    }
}

function verifyAndUnzip(zip: any) {
    var entries = zip.getEntries();

    // Find the AppxManifest.xml file
    var appxManifestEntry: any;
    for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        if (entry.name.toLowerCase() === "appxmanifest.xml") {
            appxManifestEntry = entry;
            break;
        }
    }
    if (!appxManifestEntry) {
        return false;
    }

    // The AppxManifest could be nested in a folder, but we want to unzip it
    // with the AppxManifest's location as the root
    var archivePathRoot = p.dirname(appxManifestEntry.entryName);
    zip.getEntries().forEach((entry: any) => {
        if (entry.isDirectory) {
            return;
        }
        var strippedPath = entry.entryName.replace(archivePathRoot, "");
        zip.extractEntryTo(entry, p.join(appxManifestTempPath, p.dirname(strippedPath)), false, true);
    });
    return true;
}

export function main(argv: string[], argc: number) {
    var server = net.createServer();
    server.listen(PORT);
    console.log("Creating server on port " + PORT);

    var clientAddress: string;
    server.on("connection", (socket: net.Socket) => {
        if (clientAddress) {
            if (socket.remoteAddress !== clientAddress) {
                verbose && console.log("Connection from unknown client, disconnecting...");
                socket.destroy();
                return;
            }
        } else {
            console.log("First client connection, binding to: " + socket.remoteAddress);
            clientAddress = socket.remoteAddress;
        }

        var payload: { version: number; command: string; dataLength: number; data: Buffer; };
        socket.write("ACK");

        socket.on("data", (buffer: Buffer) => {
            if (!payload) {
                // First message from client
                payload = processInitialData(buffer);
                if (payload.data.length < payload.dataLength) {
                    // Payload data got truncated
                    verbose && console.log("Payload truncated: " + payload.data.length + "/" + payload.dataLength);
                    return;
                }
            } else {
                // Subsequent messages from client containing the remainder of the data
                payload.data = Buffer.concat([payload.data, buffer]);
                verbose && console.log("Payload update: " + payload.data.length + "/" + payload.dataLength);
                if (payload.data.length < payload.dataLength) {
                    // Data still incomplete
                    return;
                }
            }

            // Entire payload received at this point

            // Check version
            if (payload.version !== PROTOCOL_VERSION) {
                console.log("Data received... version mismatch.");
                socket.destroy();
                return;
            }

            // Process data
            verbose && console.log("Processing command: " + payload.command);
            switch (payload.command) {
                case "deployAppxManifest":
                    try {
                        appxTools.terminateAppx();
                        cleanTemp();

                        // Write zip to disk
                        verbose && console.log("Writing zip to disk");
                        fs.writeFileSync(appxManifestZipPath, payload.data);

                        // Unzip to temp
                        verbose && console.log("Opening zip");
                        var zip = new admzip(appxManifestZipPath);
                        if (!verifyAndUnzip(zip)) {
                            console.log("No AppxManifest found in archive.");
                        }

                        // Register AppxManifest
                        appxTools.registerAndLaunchAppxManifest(appxManifestFilePath);
                    } catch (e) {
                        console.log(e);
                    }
                    break;

                case "exit":
                    console.log("Closing server...");
                    server.close();
                    break;

                case "launchAppx":
                    try {
                        appxTools.launchAppx();
                    } catch (e) {
                        // An exception will be thrown if we try to launch
                        // without first installing the app
                    }
                    break;

                default:
                    console.log("Unknown command");
                    break;
            }
            verbose && console.log();
            socket.write("ACK");
            socket.destroy();
        });
    });
}