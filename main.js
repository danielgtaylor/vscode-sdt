const hashSum = require("hash-sum");
const vscode = require("vscode");
const YAML = require("yaml");

const refParser = require("@apidevtools/json-schema-ref-parser");

const SCHEMA = "sdt";

// Cache maps a schema URI to a [hash, schema] pair, allowing the use of cached
// pre-computed schemas if the SDT `schemas.output` hash matches. This prevents
// having to fetch and modify the SDT schema on every edit since most edits
// will be for the inputs and template rather than the output schema.
const cache = {};

// Modify a schema to allow SDT syntax like $if/$for/$flatten/etc. This is
// called recursively (depth-first) to modify items/properties/etc children
// that are also schemas.
function modifySchema(ref, s) {
  if (s.items) {
    // This is an array, so modify the array items.
    s.items = modifySchema(`${ref}/oneOf/0/items`, s.items);
  }

  for (let i in s.properties) {
    // This is an object, so modify each property.
    s.properties[i] = modifySchema(
      `${ref}/oneOf/0/properties/${i}`,
      s.properties[i]
    );
  }

  if (s.additionalProperties && s.additionalProperties !== true) {
    // Don't forget about additional properties which are not explicitly named.
    s.additionalProperties = modifySchema(
      `${ref}/oneOf/0/additionalProperties`,
      s.additionalProperties
    );
  }

  // By default, any schema can be the original or an $if statement.
  const modified = {
    description: s.description,
    oneOf: [
      s,
      {
        type: "object",
        properties: {
          $if: {
            description: "Branching condition expression",
            oneOf: [
              {
                type: "string",
                pattern: "^\\$\\{.*\\}$",
                errorMessage: "String should be interpolated: ${...}",
              },
              {
                type: "boolean",
              },
            ],
          },
          $then: { $ref: ref },
          $else: { $ref: ref },
        },
        required: ["$if", "$then"],
        additionalProperties: false,
      },
    ],
  };

  if (s.type !== "string") {
    // Non-strings are allowed to use interpolation, but *only* if the string
    // returns a single value. That's all we can validate from JSON Schema
    // so we can't determine if the result of the expression would be the
    // right value, but it's better than nothing!
    modified.oneOf.push({
      type: "string",
      pattern: "^\\$\\{.*\\}$",
      description: "Interpolated string",
      errorMessage: "String should be interpolated: ${...}",
    });
  }

  if (s.type === "array") {
    // This is an array, which means it supports a few more things. Specifically
    // you can `$flatten` arrays into a single array output, and you can use
    // `$for` loops to generate an array output.
    modified.oneOf.push({
      type: "object",
      properties: {
        $flatten: {
          description:
            "Flatten an array of arrays one level into a single array",
          oneOf: [
            // Simple case: plain array of arrays.
            {
              type: "array",
              items: {
                $ref: ref,
              },
            },
            // Other case: `$for` loop inside of `$flatten`.
            {
              type: "object",
              properties: {
                $for: {
                  description: "For loop variable expression",
                  oneOf: [
                    {
                      type: "string",
                      pattern: "^\\$\\{.*\\}$",
                      errorMessage: "String should be interpolated: ${...}",
                    },
                    {
                      type: "array",
                    },
                  ],
                },
                $as: {
                  type: "string",
                  description: "Name of the loop variable (default is `items`)",
                  default: "items",
                },
                $each: {
                  $ref: ref,
                },
              },
              required: ["$for", "$each"],
              additionalProperties: false,
            },
          ],
        },
      },
      required: ["$flatten"],
      additionalProperties: false,
    });
    // Plain for loop case.
    modified.oneOf.push({
      type: "object",
      properties: {
        $for: {
          description: "For loop variable expression",
          oneOf: [
            {
              type: "string",
              pattern: "^\\$\\{.*\\}$",
              errorMessage: "String should be interpolated: ${...}",
            },
            {
              type: "array",
            },
          ],
        },
        $as: {
          type: "string",
          description: "Name of the loop variable (default is `items`)",
          default: "items",
        },
        $each: {
          $ref: `${ref}/oneOf/0/items`,
        },
      },
      required: ["$for", "$each"],
      additionalProperties: false,
    });
  }

  // TODO: rewrite any left over $refs as there may be circular references
  // and we've now changed the structure.

  return modified;
}

function onRequestSchemaURI(resource) {
  // console.log(`Request URI ${resource}`);
  if (resource.endsWith(".sdt.yaml")) {
    return `${SCHEMA}://${resource.substr(7)}`;
  }

  return undefined;
}

async function onRequestSchemaContent(schemaUri) {
  // console.log(`Request content ${schemaUri}`);
  if (!schemaUri.startsWith(SCHEMA + "://")) {
    return undefined;
  }

  // Start by parsing the current document from the editor.
  let parsed = {};
  let hash = "";
  try {
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.path == schemaUri.substr(SCHEMA.length + 3)) {
        parsed = YAML.parse(doc.getText().toString());

        // See if we have this schema cached already.
        if (parsed && parsed.schemas && parsed.schemas.output) {
          hash = hashSum(parsed.schemas.output);
          if (cache[schemaUri]) {
            const [oldHash, schema] = cache[schemaUri];
            if (oldHash === hash) {
              // console.log("Returning cached schema");
              return schema;
            }
          }
        }

        break;
      }
    }
  } catch (err) {
    console.log(err);
  }

  // Create a basic generic schema for SDT, leaving the `template` portion
  // blank for now.
  const schema = {
    type: "object",
    properties: {
      schemas: {
        type: "object",
        description: "Input and output schemas",
        properties: {
          dialect: {
            type: "string",
            description:
              "Default JSON Schema dialect if none is explicitly given via the $schema keyword",
            enum: [
              "openapi-3.1",
              "openapi-3.0",
              "http://json-schema.org/schema",
              "https://json-schema.org/draft/2020-12/schema",
              "https://json-schema.org/draft/2019-09/schema",
              "https://json-schema.org/draft-07/schema",
              "https://json-schema.org/draft-06/schema",
              "https://json-schema.org/draft-04/schema",
            ],
          },
          // VSCode only supports draft-07 and older at the moment.
          // TODO: update this once VSCode supports 2019/2020.
          input: {
            $ref: "https://json-schema.org/draft-07/schema",
          },
          output: {
            $ref: "https://json-schema.org/draft-07/schema",
          },
        },
      },
    },
  };

  // Try and generate a schema for the `template` based on the given output
  // schema if present.
  if (parsed && parsed.schemas && parsed.schemas.output) {
    try {
      const resolved = await refParser.dereference(parsed.schemas.output);
      schema.properties.template = modifySchema(
        "#/properties/template",
        resolved
      );
    } catch (err) {
      console.log(err);
    }
  }

  const serialized = JSON.stringify(schema);
  cache[schemaUri] = [hash, serialized];
  return serialized;
}

vscode.extensions
  .getExtension("redhat.vscode-yaml")
  .activate()
  .catch((err) => {
    console.log(err);
  })
  .then((yamlExtensionAPI) => {
    yamlExtensionAPI.registerContributor(
      SCHEMA,
      onRequestSchemaURI,
      onRequestSchemaContent
    );
  });
