appname="onvif-discovery"

path=dist/mac

mkdir -p $path

npx esbuild main.js --bundle --platform=node --outfile=dist/out.js

node --experimental-sea-config sea-config.json

cp $(command -v node) $path/$appname

chmod 777 $path/$appname

codesign --remove-signature $path/$appname

npx postject $path/$appname NODE_SEA_BLOB dist/sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
  --macho-segment-name NODE_SEA

codesign --sign - $path/$appname
