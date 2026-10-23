# Stage 2: Build the NestJS application
FROM node:22.23.4-alpine AS nestjs-builder
RUN apk add --no-cache git
# hadolint ignore=DL3018
RUN apk add --no-cache --upgrade ca-certificates ca-certificates-bundle
# Node bundles its own roots; use the system store so CA removals apply
ENV NODE_OPTIONS=--use-openssl-ca
RUN corepack enable && corepack prepare yarn@3.6.4 --activate

WORKDIR /app

RUN chown node /app
RUN chown node .

USER node

# Copy the package.json and yarn.lock to the working directory
#COPY fasset-user-ui-backend/package.json fasset-user-ui-backend/yarn.lock ./

#RUN yarn

# Copy the rest of the application source code
COPY --chown=node . .

# Build the NestJS application
RUN yarn

RUN yarn build

# Expose port 3001
EXPOSE 3001
#Build with sudo docker build -f Dockerfile -t demodapp ../../
# Start the application
CMD ["yarn", "run", "start"]
