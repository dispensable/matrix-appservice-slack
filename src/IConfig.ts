/*
Copyright 2019 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// This should follow the format in slack-config-schema.yaml

type LogEnum = "error"|"warn"| "info"|"debug"|"off";

export interface IConfig {
    slack_hook_port: number;
    inbound_uri_prefix: string;
    bot_username: string;
    username_prefix: string;

    slack_master_token?: string;

    matrix_admin_room?: string;

    homeserver: {
        url: string;
        server_name: string;
        media_url?: string;
    };

    tls: {
        key_file: string;
        crt_file: string;
    };

    logging: {
        console: LogEnum;
        fileDatePattern: string;
        timestampFormat: string;
        files: {[filename: string]: LogEnum}
    };

    oauth2?: {
        client_id: string;
        client_secret: string;
        redirect_prefix?: string;
    };

    enable_metrics: boolean;

    dbdir: string;

}
