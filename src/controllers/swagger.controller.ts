import { Controller, Get, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Response } from "express";
import * as fs from "fs";
import * as path from "path";

@ApiTags("Swagger")
@Controller("api")
export class SwaggerController {
    @Get("json")
    getSwaggerJson(@Res() res: Response) {
        const swaggerFilePath = path.join(__dirname, "..", "..", "/swagger-docs", "swagger.json");
        if (fs.existsSync(swaggerFilePath)) {
            const swaggerJson = fs.readFileSync(swaggerFilePath, "utf8");
            res.header("Content-Type", "application/json");
            res.send(JSON.parse(swaggerJson));
        } else {
            res.status(404).send({ message: "swagger.json not found" });
        }
    }
}
