/**
 * @file deleteUser.js
 * @module deleteUser
 * @description
 * AWS Lambda handler to delete a user from Cognito and DynamoDB,
 * plus purge all their Conversations entries.
 */


// From github

import { DynamoDBClient, DeleteItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import {
  CognitoIdentityProviderClient,
  AdminDeleteUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const REGION                         = process.env.AWS_REGION           || "us-east-2";
const USER_POOL_ID                   = process.env.COGNITO_USER_POOL_ID;
const USERS_TABLE                    = process.env.USERS_TABLE         || "Users";
const CONVERSATIONS_TABLE            = process.env.CONVERSATIONS_TABLE || "Conversations";
const ASSOCIATED_ACCOUNT_INDEX       = "associated_account-is_first_email-index";

if (!USER_POOL_ID) {
  throw new Error("Missing required env var: COGNITO_USER_POOL_ID");
}

const cognitoClient = new CognitoIdentityProviderClient({ region: REGION });
const dynamoDb      = new DynamoDBClient({ region: REGION });
const lambdaClient  = new LambdaClient({ region: REGION });

async function getCorsHeaders(event) {
  try {
    const res = await lambdaClient.send(new InvokeCommand({
      FunctionName:   "Allow-Cors",
      InvocationType: "RequestResponse",
      Payload:        JSON.stringify(event),
    }));
    const payload = JSON.parse(new TextDecoder().decode(res.Payload));
    return payload.headers;
  } catch {
    return {
      "Access-Control-Allow-Origin":      "*",
      "Access-Control-Allow-Methods":     "OPTIONS, POST",
      "Access-Control-Allow-Headers":     "Content-Type",
      "Access-Control-Allow-Credentials": "true",
    };
  }
}

export const handler = async (event) => {
  const cors = await getCorsHeaders(event);

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: cors, body: "" };
  }

  let email;
  try {
    const body = JSON.parse(event.body || "{}");
    email = body.email;
    if (!email) throw new Error("Missing required field: email");
  } catch (err) {
    return {
      statusCode: 400,
      headers: cors,
      body: JSON.stringify({ message: `Invalid request: ${err.message}` }),
    };
  }

  try {
    // 1) Delete from Cognito
    await cognitoClient.send(new AdminDeleteUserCommand({
      UserPoolId: USER_POOL_ID,
      Username:   email,
    }));

    // 2) Delete from Users table
    await dynamoDb.send(new DeleteItemCommand({
      TableName: USERS_TABLE,
      Key: {
        id: { S: email },
      },
    }));

    // 3) Query all Conversations where associated_account = email
    const { Items: convItems = [] } = await dynamoDb.send(new QueryCommand({
      TableName:              CONVERSATIONS_TABLE,
      IndexName:              ASSOCIATED_ACCOUNT_INDEX,
      KeyConditionExpression: "associated_account = :email",
      ExpressionAttributeValues: {
        ":email": { S: email },
      },
    }));

    // 4) Delete each matching conversation
    const deletePromises = convItems.map(item =>
      dynamoDb.send(new DeleteItemCommand({
        TableName: CONVERSATIONS_TABLE,
        Key: {
          // <-- replace these with your actual PK/SK attribute names:
          conversationId: item.conversation_id,
          // if your table has a sort key, include it here:
          sortKeyName: item.response_id,
        },
      }))
    );
    await Promise.all(deletePromises);

    // 5) Success response
    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({ message: "User and conversations successfully deleted" }),
    };
  } catch (err) {
    console.error("Deletion error:", err);
    const isNotFound = err.name === "UserNotFoundException";
    return {
      statusCode: isNotFound ? 404 : 500,
      headers: cors,
      body: JSON.stringify({ message: err.message }),
    };
  }
};
