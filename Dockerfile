# Use the official Playwright Docker image as the base.
# It includes Node.js and all necessary browser dependencies.
# We are using v1.54.0-jammy which is compatible with Playwright 1.54.x
# and uses Ubuntu 22.04 LTS (Jammy Jellyfish).
FROM mcr.microsoft.com/playwright:v1.54.0-jammy

# Set the working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json (if you have one) first.
# This step is optimized for Docker caching: if dependencies don't change,
# this layer won't be rebuilt.
COPY package*.json ./

# Install Node.js dependencies.
# npm ci is preferred over npm install in CI/CD environments for consistent builds.
# It uses package-lock.json if available.
RUN npm ci --production

# Copy the rest of your application's source code into the container.
COPY . .

# Expose the port your Express application listens on.
# Render automatically maps this port.
EXPOSE 3000

# Define the command to run your application when the container starts.
# This should match the "start" script in your package.json.
CMD ["npm", "start"]