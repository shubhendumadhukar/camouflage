import express from "express";
import path from "path";
import fs from "fs";
import os from "os";
import Handlebars from "handlebars";
import logger from "../logger";
let DELAY: number = 0;
/**
 * Create a parser class which defines methods to parse
 * 1. Request URL to get a matching directory
 * 2. From matched directory get .mock file content and generate a response
 * @param {express.Request} req Express Request object used to perform request url parsing
 * @param {string} mockDir Location of all mocks
 * @param {express.Response} res Express response to send the parsed response body and headers to client
 */
export class Parser {
  private req: express.Request;
  private mockDir: string;
  private res: express.Response;
  constructor(req: express.Request, res: express.Response, mockDir: string) {
    this.req = req;
    this.mockDir = mockDir;
    this.res = res;
  }
  getMatchedDir = () => {
    const reqDetails = {
      method: this.req.method.toUpperCase(),
      path: this.req.path,
      protocol: this.req.protocol,
      httpVersion: this.req.httpVersion,
      query: this.req.query,
      headers: this.req.headers,
      body: this.req.body,
    };
    const matchedDir = getWildcardPath(reqDetails.path, this.mockDir);
    return matchedDir;
  };

  getResponse = (mockFile: string) => {
    // Default response
    let response = {
      status: 404,
      body: '{"error": "Not Found"}',
      headers: {
        "content-type": "application/json",
      },
    };
    // Check if mock file exists
    if (fs.existsSync(mockFile)) {
      this.prepareResponse(mockFile);
    } else {
      logger.error(`No suitable mock file found: ${mockFile}`);
      if (fs.existsSync(path.join(this.mockDir, "__", "GET.mock"))) {
        logger.debug(`Found a custom global override for default response. Sending custom default response.`);
        this.prepareResponse(path.join(this.mockDir, "__", "GET.mock"));
      } else {
        //If no mockFile is found, return default response
        logger.debug(`No custom global override for default response. Sending default Camouflage response.`);
        this.res.statusCode = response.status;
        let headerKeys = Object.keys(response.headers);
        headerKeys.forEach((headerKey) => {
          // @ts-ignore
          res.setHeader(headerKey, response.headers[headerKey]);
        });
        this.res.send(response.body);
      }
    }
  };
  private prepareResponse = (mockFile: string) => {
    /**
     * Since response file contains headers and body both, a PARSE_BODY flag is required
     * to tell the logic if it's currently parsing headers or body
     * Set responseBody to an empty string and set a default response object
     */
    let PARSE_BODY = false;
    let responseBody = "";
    let response = {
      status: 404,
      body: '{"error": "Not Found"}',
      headers: {
        "content-type": "application/json",
      },
    };
    // Compile the handlebars used in the contents of mockFile
    const template = Handlebars.compile(fs.readFileSync(mockFile).toString());
    // Generate actual response i.e. replace handlebars with their actual values and split the content into lines
    const fileContent = template({ request: this.req, logger: logger }).split(os.EOL);
    //Read file line by line
    fileContent.forEach((line, index) => {
      /**
       * Set PARSE_BODY flag to try when reader finds a blank line,
       * since according to standard format of a raw HTTP Response,
       * headers and body are separated by a blank line.
       */
      if (line === "") {
        PARSE_BODY = true;
      }
      //If line includes HTTP/HTTPS i.e. first line. Get the response status code
      if (line.includes("HTTP")) {
        const regex = /(?<=HTTP\/\d).*?\s+(\d{3,3})/i;
        if (!regex.test(line)) {
          logger.error("Response code should be valid string");
          throw new Error("Response code should be valid string");
        }
        response.status = <number>(<unknown>line.match(regex)[1]);
        logger.debug("Response Status set to " + response.status);
      } else {
        /**
         * If following conditions are met:
         *      Line is not blank
         *      And parser is not currently parsing response body yet i.e. PARSE_BODY === false
         * Then:
         *      Split line by :, of which first part will be header key and 2nd part will be header value
         *      If headerKey is response delay, set variable DELAY to headerValue
         */
        if (line !== "" && !PARSE_BODY) {
          let headerKey = line.split(":")[0];
          let headerValue = line.split(":")[1];
          if (headerKey === "Response-Delay") {
            DELAY = <number>(<unknown>headerValue);
            logger.debug(`Delay Set ${headerValue}`);
          } else {
            this.res.setHeader(headerKey, headerValue);
            logger.debug(`Headers Set ${headerKey}: ${headerValue}`);
          }
        }
      }
      // If parsing response body. Concatenate every line till last line to a responseBody variable
      if (PARSE_BODY) {
        responseBody = responseBody + line;
      }
      /**
       * If on last line, do following:
       *    Trim and remove whitespaces from the responseBody
       *    Compile the Handlebars to generate a final response
       *    Set PARSE_BODY flag back to false and responseBody to blank
       *    Set express.Response Status code to response.status
       *    Send the generated Response, from a timeout set to send the response after a DELAY value
       */
      if (index == fileContent.length - 1) {
        this.res.statusCode = response.status;
        if (responseBody.includes("camouflage_file_helper")) {
          const fileResponse = responseBody.split(";")[1];
          setTimeout(() => {
            this.res.sendFile(fileResponse);
          }, DELAY);
        } else {
          responseBody = responseBody.replace(/\s+/g, " ").trim();
          responseBody = responseBody.replace(/{{{/, "{ {{");
          responseBody = responseBody.replace(/}}}/, "}} }");
          const template = Handlebars.compile(responseBody);
          try {
            const codeResponse = JSON.parse(responseBody);
            switch (codeResponse["CamouflageResponseType"]) {
              case "code":
                this.res.statusCode = codeResponse["status"] || this.res.statusCode;
                if (codeResponse["headers"]) {
                  Object.keys(codeResponse["headers"]).forEach((header) => {
                    this.res.setHeader(header, codeResponse["headers"][header]);
                  });
                }
                setTimeout(() => {
                  logger.debug(`Generated Response ${codeResponse["body"]}`);
                  this.res.send(codeResponse["body"]);
                });
                break;
              default:
                setTimeout(() => {
                  logger.debug(`Generated Response ${template({ request: this.req, logger: logger })}`);
                  this.res.send(template({ request: this.req, logger: logger }));
                }, DELAY);
                break;
            }
          } catch (error) {
            logger.warn(error.message);
            setTimeout(() => {
              logger.debug(`Generated Response ${template({ request: this.req, logger: logger })}`);
              this.res.send(template({ request: this.req, logger: logger }));
            }, DELAY);
          }
        }
        PARSE_BODY = false;
        responseBody = "";
        DELAY = 0;
      }
    });
  };
}

const removeBlanks = (array: Array<any>) => {
  return array.filter(function (i) {
    return i;
  });
};
const getWildcardPath = (dir: string, mockDir: string) => {
  let steps = removeBlanks(dir.split("/"));
  let testPath;
  let newPath = path.resolve(mockDir);
  while (steps.length) {
    let next = steps.shift();
    testPath = path.join(newPath, next);
    if (fs.existsSync(testPath)) {
      newPath = testPath;
      testPath = path.join(newPath, next);
    } else {
      testPath = path.join(newPath, "__");
      if (fs.existsSync(testPath)) {
        newPath = testPath;
        continue;
      } else {
        newPath = testPath;
        break;
      }
    }
  }
  return newPath;
};
