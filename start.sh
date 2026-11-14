docker stop 9router-ultimate
docker rm 9router-ultimate
docker build -t 9router-ultimate .
docker run -d --name 9router-ultimate -p 20127:20127 --env-file .env -v 9router-data:/app/data 9router-ultimate
