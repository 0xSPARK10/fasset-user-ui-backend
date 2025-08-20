import { Injectable, OnModuleInit } from "@nestjs/common";
import * as fs from "fs";
import * as path from "path";

@Injectable()
export class VersionService implements OnModuleInit {
    private version: string;

    onModuleInit() {
        this.version = this.loadVersionFromPackageJson();
    }

    private loadVersionFromPackageJson(): string {
        const pkgPath = path.resolve(__dirname, "../../package.json");
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        return pkg.version;
    }
    getVersion(): string {
        return this.version;
    }
}
